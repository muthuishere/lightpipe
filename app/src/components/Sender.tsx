import { useCallback, useEffect, useRef, useState } from "react";
import optical from "../optical";
import type { Manifest, OpticalSender, Profile } from "../wasm-api";
import { readFileStreaming, SAFE_LIMIT } from "../lib/file-source";
import { DEFAULT_META, envelopeOverhead, sniff, wrap, type EnvelopeMeta } from "../lib/envelope";
import { bytes, duration, int, rate } from "../lib/format";
import { estimate, GOOD_BPS, POTATO_BPS } from "../lib/estimate";
import { probeImage, reencode, swapExtension } from "../lib/image";
import { isImage } from "../lib/envelope";
import { planForDisplay, probeProfiles, type DisplayPlan } from "../lib/frame-plan";

type Phase = "idle" | "reading" | "ready" | "sending";
type Input = "file" | "text";

/**
 * The user-facing control is ONE trade-off: how forgiving of a bad camera
 * versus how fast. "L0", "P8", "20 px cells" and "the potato rung" are our
 * words, not theirs — the raw profile id stays available as a caption and a
 * tooltip so we can still talk about it, but it never leads.
 */
/**
 * Frame shape.
 *
 * Not cosmetic. S4 measured that screen area IS resolution: whatever fraction
 * of the sensor the sending screen fails to fill is throughput thrown away. A
 * phone held upright pointed at a landscape frame letterboxes it into roughly
 * half the sensor, so the frame should be the shape of the thing looking at it.
 *
 * There is no back-channel, so the receiver cannot tell us what shape it is
 * (ADR-0016 would fix this if the handshake is ever wired). Until then: default
 * from this device, and let the person override.
 */
type Shape = "auto" | "landscape" | "portrait";

const SHAPES: Array<{ id: Shape; label: string; caption: string }> = [
  { id: "auto", label: "Match this screen (recommended)", caption: "fills the display edge to edge" },
  { id: "landscape", label: "Force landscape", caption: "1920 x 1080" },
  { id: "portrait", label: "Force portrait", caption: "1080 x 1920" },
];

interface Speed {
  id: Profile;
  label: string;
  help: string;
}

/**
 * ONE trade-off, in the user's words. "L0", "P8", "20 px cells" and "the potato
 * rung" are our vocabulary, not theirs — the raw profile id stays available as
 * a caption and a tooltip, but it never leads.
 */
const SPEEDS: Speed[] = [
  {
    id: "auto",
    label: "Auto — pick for me",
    help: "Picks the most forgiving setting the payload can afford.",
  },
  {
    id: "L0",
    label: "Most reliable (slowest)",
    help: "Biggest blocks. Works on weak cameras, bad light and shaky hands.",
  },
  { id: "L1", label: "Reliable", help: "A good balance for a typical webcam." },
  { id: "L2", label: "Balanced", help: "Faster. Wants a decent camera and steady framing." },
  { id: "L3", label: "Fast", help: "For a good phone camera, well lit and held still." },
  {
    id: "L4",
    label: "Fastest (needs a great camera)",
    help: "Densest picture. A phone camera up close, or a screen capture.",
  },
];

export interface SenderProps {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  onSendingChange: (sending: boolean) => void;
  active: boolean;
}

export default function Sender({ canvasRef, onSendingChange, active }: SenderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [input, setInput] = useState<Input>("file");
  const [meta, setMeta] = useState<EnvelopeMeta | null>(null);
  const [payloadSize, setPayloadSize] = useState(0);
  const [text, setText] = useState("");
  const [readPct, setReadPct] = useState(0);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile>("auto");
  /**
   * Auto means "the exact shape of the area this will be shown in". Forcing a
   * shape that does not match the display letterboxes the code into a fraction
   * of the screen, which is magnification thrown away before the camera even
   * looks — the cause of a real desktop send that decoded nothing.
   */
  const [shape, setShape] = useState<Shape>("auto");
  /**
   * Fullscreen is a CSS MODE, not an API call.
   *
   * `Element.requestFullscreen()` does not exist for non-video elements in iOS
   * Safari, so a button that depends on it does nothing at all on an iPhone —
   * which is where this was reported from. A fixed-position container works
   * identically everywhere, needs no user-gesture permission, and (the reason
   * that matters here) gives us full control of the layout so status can live
   * in the letterbox dead space instead of on top of the code.
   *
   * The real API is layered on top where it exists, purely to hide browser
   * chrome as well.
   */
  const [immersive, setImmersive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [still, setStill] = useState(false);
  const [framesPerPass, setFramesPerPass] = useState(0);
  const [plan, setPlan] = useState<DisplayPlan | null>(null);
  const [testPattern, setTestPattern] = useState(false);
  // Which quality settings this engine actually round-trips. Probed once.
  const [usable, setUsable] = useState<Set<Profile> | null>(null);
  const [stat, setStat] = useState({ frames: 0, fps: 0, chunk: 0, chunkCount: 0, elapsed: 0 });
  const [original, setOriginal] = useState<{
    meta: EnvelopeMeta;
    bytes: Uint8Array;
    dims: { width: number; height: number } | null;
  } | null>(null);
  const [quality, setQuality] = useState(0.8);
  const [maxDim, setMaxDim] = useState(0);
  const [shrunk, setShrunk] = useState<{
    meta: EnvelopeMeta;
    size: number;
    width: number;
    height: number;
  } | null>(null);
  const [working, setWorking] = useState(false);

  const senderRef = useRef<OpticalSender | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  useEffect(
    () => () => {
      stopLoop();
      senderRef.current?.free();
    },
    [stopLoop],
  );

  useEffect(() => {
    // One-off capability probe. Cheap, and it means the UI never offers a
    // setting that would silently decode nothing.
    const id = window.setTimeout(() => setUsable(probeProfiles(optical)), 0);
    return () => window.clearTimeout(id);
  }, []);

  /**
   * The frame is planned against the area it will be SHOWN in, so that area
   * changing invalidates the plan. Entering fullscreen is the big one: a frame
   * planned for a 1140 px windowed canvas, then blown up to 1920, was drawn for
   * the wrong aspect and the wrong scale — the code ended up a fraction of the
   * screen with tiny cells, which is the bug that stopped cameras decoding.
   */
  useEffect(() => {
    if (phase !== "sending" || !bytesRef.current) return;
    const id = window.setTimeout(() => replanAndRestart(), 60);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immersive]);

  useEffect(() => {
    if (phase !== "sending") return;
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => replanAndRestart(), 250);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Nothing scrolls behind the immersive view, and Escape always gets out.
  useEffect(() => {
    if (!immersive) return;
    document.body.classList.add("immersive-open");
    // The scrolling element is <html>, not <body>, in most engines — locking
    // only the body still lets the page move behind the overlay.
    document.documentElement.classList.add("immersive-open");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitImmersive();
    };
    // If the user leaves the browser's own fullscreen (Esc on desktop), leave
    // our CSS mode with it so the two cannot disagree.
    const onFs = () => {
      if (!document.fullscreenElement) setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.body.classList.remove("immersive-open");
      document.documentElement.classList.remove("immersive-open");
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [immersive]);

  /** Load bytes into the sender. One path — every affordance ends up here. */
  const load = useCallback(
    async (m: EnvelopeMeta, payload: Uint8Array, keepOriginal = true) => {
      setError(null);
      setManifest(null);
      setStill(false);
      setFramesPerPass(0);
      const enveloped = wrap(m, payload);
      bytesRef.current = enveloped;
      setMeta(m);
      setPayloadSize(payload.length);
      if (keepOriginal) {
        setShrunk(null);
        const dims = isImage(m.mime) ? await probeImage(new Blob([payload as BlobPart], { type: m.mime })) : null;
        setOriginal({ meta: m, bytes: payload, dims });
      }
      const s = buildSender(enveloped);
      senderRef.current?.free();
      senderRef.current = s;
      const man = s.manifest();
      setManifest(man);
      setFramesPerPass(passLength(man.totalBytes));
      setPhase("ready");
    },
    // dims() and the frame plan are read at call time, so every piece of state
    // they touch has to be a dependency or the sender is built from stale values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, shape, usable],
  );

  const takeFile = useCallback(
    async (f: File) => {
      setNote(null);
      setPhase("reading");
      setReadPct(0);
      if (f.size > SAFE_LIMIT) {
        setPhase("idle");
        setError(
          `${bytes(f.size)} is above the ${bytes(SAFE_LIMIT)} ceiling this build accepts. ` +
            `Not a browser limit — the frozen wasm contract's OpticalSender.create() takes the ` +
            `whole file as one Uint8Array, so a streaming send cannot be expressed yet. ` +
            `Large files need a streaming send, which the core cannot express yet.`,
        );
        return;
      }
      try {
        // ADR-0008: file.stream(), never readAsArrayBuffer.
        const data = await readFileStreaming(f, (p) => setReadPct(p.read / Math.max(1, p.total)));
        await load(sniff(f.name, f.type), data);
      } catch (err) {
        setError(String(err));
        setPhase("idle");
      }
    },
    [load],
  );

  const takeText = useCallback(
    async (value: string, name = DEFAULT_META.name, mime = DEFAULT_META.mime) => {
      setNote(null);
      await load({ name, mime }, new TextEncoder().encode(value));
    },
    [load],
  );

  /* ---- clipboard: Cmd/Ctrl+V anywhere on the send view sends what is there -- */
  useEffect(() => {
    if (!active || phase === "sending") return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === "TEXTAREA") return; // let typing work
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            const name = f.name || `pasted.${(f.type.split("/")[1] || "bin").split("+")[0]}`;
            setNote(`Pasted ${f.type || "file"} from the clipboard.`);
            void takeFile(new File([f], name, { type: f.type }));
            return;
          }
        }
      }
      const pasted = e.clipboardData?.getData("text/plain");
      if (pasted && pasted.trim()) {
        e.preventDefault();
        setInput("text");
        setText(pasted);
        setNote("Pasted text from the clipboard — sending as markdown.");
        void takeText(pasted);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [active, phase, takeFile, takeText]);

  async function applyReencode() {
    if (!original) return;
    setWorking(true);
    try {
      const src = new Blob([original.bytes as BlobPart], { type: original.meta.mime });
      const out = await reencode(src, quality, maxDim);
      if (!out) {
        setError("This browser could not re-encode that image. Sending the original.");
        return;
      }
      const m = { name: swapExtension(original.meta.name, out.mime), mime: out.mime };
      setShrunk({ meta: m, size: out.bytes.length, width: out.width, height: out.height });
      await load(m, out.bytes, false);
    } finally {
      setWorking(false);
    }
  }

  async function useOriginal() {
    if (!original) return;
    setShrunk(null);
    await load(original.meta, original.bytes, false);
  }

  /**
   * The area the code will actually be displayed in, in CSS pixels.
   *
   * NOT the frame, and not the whole window: the canvas sits between the two
   * status strips, and that box is what the camera ends up looking at. Matching
   * the frame's aspect to THIS is what stops the code being letterboxed into a
   * fraction of the screen.
   */
  function viewArea() {
    const wrap = wrapRef.current;
    if (wrap && wrap.clientWidth > 40 && wrap.clientHeight > 40) {
      return { w: wrap.clientWidth, h: wrap.clientHeight };
    }
    // Before the stage exists, predict the immersive layout: full viewport
    // minus the two strips.
    const w = window.innerWidth;
    const h = Math.max(200, window.innerHeight - 140);
    return { w, h };
  }

  /**
   * Build the sender against the frame that puts the BIGGEST CELLS on the
   * glass — matching the display's aspect so nothing is letterboxed, and as
   * small in pixels as the payload allows so it is scaled up hardest.
   */
  function buildSender(payload: Uint8Array) {
    const view = viewArea();
    const forced = shape === "auto" ? null : shape;
    const area =
      forced === "landscape" ? { w: 1920, h: 1080 } : forced === "portrait" ? { w: 1080, h: 1920 } : view;
    const p = planForDisplay(optical, payload, {
      totalBytes: payload.length,
      requested: profile,
      usable: usable ?? undefined,
      viewW: area.w,
      viewH: area.h,
    });
    try {
      const s = optical.OpticalSender.create(payload, {
        profile: p.profile,
        width: p.width,
        height: p.height,
      });
      setPlan(p);
      return s;
    } catch {
      // The core refused that frame. A full-size one at the requested quality
      // always builds, and saying nothing would be worse.
      const fw = area.w >= area.h ? 1920 : 1080;
      const fh = area.w >= area.h ? 1080 : 1920;
      const s = optical.OpticalSender.create(payload, { profile, width: fw, height: fh });
      setPlan({ ...p, profile, width: fw, height: fh, cellPx: 0, screenPitch: 0 });
      return s;
    }
  }

  /**
   * How many pictures is one full pass through the payload?
   *
   * This CANNOT be discovered by watching the frames: a real fountain code
   * never repeats itself, so there is no cycle to detect. It comes from the
   * engine's own per-frame capacity.
   */
  function passLength(totalBytes: number): number {
    const view = viewArea();
    return planForDisplay(optical, new Uint8Array(Math.min(totalBytes, 4096)), {
      totalBytes,
      requested: profile,
      usable: usable ?? undefined,
      viewW: view.w,
      viewH: view.h,
    }).framesPerPass;
  }

  function rebuildSender() {
    const data = bytesRef.current;
    if (!data) return null;
    senderRef.current?.free();
    const s = buildSender(data);
    senderRef.current = s;
    setManifest(s.manifest());
    return s;
  }

  function start() {
    const s = rebuildSender();
    if (!s) return;
    setPhase("sending");
    setStill(false);
    setFramesPerPass(0);
    onSendingChange(true);
    runLoop(s);
  }

  /** The broadcast loop itself, separated so a replan can restart it. */
  function runLoop(s: OpticalSender) {
    const t0 = performance.now();
    let frames = 0;
    const known = plan?.framesPerPass || passLength(s.manifest().totalBytes);
    setFramesPerPass(known);
    setStill(known === 1);
    /**
     * A payload only a few pictures long is far easier to capture if each one
     * is held on screen instead of flickering past in 16 ms.
     */
    const holdMs = known > 0 && known <= 6 ? 400 : 0;
    let lastDrawn = 0;
    const window1s: number[] = [];

    const tick = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const now0 = performance.now();
      if (holdMs && now0 - lastDrawn < holdMs) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastDrawn = now0;
      const f = s.nextFrame();
      if (canvas.width !== f.width || canvas.height !== f.height) {
        canvas.width = f.width;
        canvas.height = f.height;
      }
      const ctx = canvas.getContext("2d", { alpha: false });
      if (ctx) {
        // Zero-copy: the ImageData is a view straight into wasm linear memory.
        const view = new Uint8ClampedArray(optical.memory.buffer as ArrayBuffer, f.ptr, f.len);
        ctx.putImageData(new ImageData(view, f.width, f.height), 0, 0);
      }

      frames++;
      const now = performance.now();
      window1s.push(now);
      while (window1s.length && now - window1s[0] > 1000) window1s.shift();
      if (frames % 5 === 0) {
        const p = s.progress();
        setStat({
          frames: p.framesEmitted,
          fps: window1s.length,
          chunk: p.chunk,
          chunkCount: p.chunkCount,
          elapsed: (now - t0) / 1000,
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function enterImmersive() {
    setImmersive(true);
    // Progressive enhancement only. Undefined on iOS Safari for non-video
    // elements, and rejected without a gesture elsewhere — neither matters,
    // because the CSS mode is what delivers the layout.
    void stageRef.current?.requestFullscreen?.().catch(() => undefined);
  }

  function exitImmersive() {
    setImmersive(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }

  /**
   * ADR-0017 test pattern. A STATIC known frame — full palette, all four
   * markers — so the person aiming can hold the phone still while the other
   * side runs its checks. Nothing changes underneath them, which is the whole
   * point: a moving target cannot be measured.
   */
  function showTestPattern() {
    const known = new TextEncoder().encode(
      "lightpipe test pattern — hold steady and run Check my setup on the receiving device.",
    );
    const payload = wrap({ name: "test-pattern.txt", mime: "text/plain" }, known);
    bytesRef.current = payload;
    setTestPattern(true);
    setStill(true);
    setPhase("sending");
    onSendingChange(true);
    enterImmersive();
    // The replan effect that fires on entering fullscreen renders it, so the
    // pattern is planned for the screen it will actually be shown on.
  }

  /**
   * Back to the setup screen without leaving fullscreen and hunting for
   * controls. Stop halts the broadcast; Reset halts it AND puts the
   * pick-a-payload screen back in front of you.
   */
  function reset() {
    stopLoop();
    setTestPattern(false);
    setStill(false);
    setImmersive(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onSendingChange(false);
    setPhase("idle");
    setManifest(null);
    setPlan(null);
    setFramesPerPass(0);
    senderRef.current?.free();
    senderRef.current = null;
  }

  /** Rebuild for the current display area and carry on broadcasting. */
  function replanAndRestart() {
    if (!bytesRef.current) return;
    const before = plan;
    stopLoop();
    const s = rebuildSender();
    if (!s) return;
    void before;
    runLoop(s);
  }

  function stop() {
    stopLoop();
    setTestPattern(false);
    setPhase("ready");
    setStill(false);
    onSendingChange(false);
    exitImmersive();
  }

  const sending = phase === "sending";
  const perFrame = framesPerPass > 0 ? Math.ceil((manifest?.totalBytes ?? 0) / framesPerPass) : 0;

  return (
    <>
      {error && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          <strong>Cannot send this</strong>
          {error}
        </div>
      )}

      {!sending && (
        <div
          className={`panel${dragging ? " dropping" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) {
              setNote(`Dropped ${f.name}.`);
              void takeFile(f);
            }
          }}
        >
          <div className="notice small" style={{ marginBottom: 12 }}>
            <strong>Start the receiving device first.</strong>
            Get it aimed and reading before you start sending — this screen broadcasts blind and
            cannot tell whether anyone is watching.{" "}
            <button className="linkish" onClick={showTestPattern}>
              Show a test pattern
            </button>{" "}
            so the other side can check its setup.
          </div>

          <h2>1 · What are you sending?</h2>
          <p className="hint">
            Drop a file anywhere on this panel, or press ⌘V / Ctrl+V to send whatever is on your
            clipboard — a screenshot, a snippet, a key. Untyped text goes as markdown.
          </p>

          <div className="row" style={{ marginBottom: 14 }}>
            <button
              className={`btn${input === "file" ? " primary" : ""}`}
              onClick={() => setInput("file")}
            >
              File
            </button>
            <button
              className={`btn${input === "text" ? " primary" : ""}`}
              onClick={() => setInput("text")}
            >
              Text / note
            </button>
          </div>

          {input === "file" ? (
            <div className="row">
              <label className="file">
                <input
                  type="file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void takeFile(f);
                  }}
                />
                <span>{meta ? meta.name : "Choose a file…"}</span>
              </label>
            </div>
          ) : (
            <>
              <textarea
                className="note-input"
                rows={7}
                value={text}
                placeholder={"# note\n\nType or paste anything. Markdown is rendered on the other side."}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn"
                  disabled={!text.trim()}
                  onClick={() => void takeText(text)}
                >
                  Use this note
                </button>
                <span className="small muted">
                  {new TextEncoder().encode(text).length} B · sent as{" "}
                  <span className="mono">text/markdown</span>
                </span>
              </div>
            </>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <label className="small muted">
              Reliability vs speed{" "}
              <select
                value={profile}
                title={`profile ${profile}`}
                // Set once the engine has been probed, so a test (or a human
                // reading the DOM) can tell "not yet checked" from "all fine".
                data-probed={usable ? "true" : "false"}
                onChange={(e) => setProfile(e.target.value as Profile)}
              >
                {SPEEDS.map((p) => {
                  const off = usable !== null && !usable.has(p.id);
                  return (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={off}
                      title={`profile ${p.id}`}
                    >
                      {p.label}
                      {off ? " — not available in this build" : ""}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="small muted">
              Screen shape{" "}
              <select value={shape} onChange={(e) => setShape(e.target.value as Shape)}>
                {SHAPES.map((r) => (
                  <option key={r.id} value={r.id} title={r.caption}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="small muted" style={{ marginTop: 8 }}>
            {SPEEDS.find((x) => x.id === profile)?.help}{" "}
            <span className="tag" title="internal profile id">
              {profile}
            </span>
          </div>

          {usable && usable.size < SPEEDS.length && (
            <div className="small muted" style={{ marginTop: 6 }}>
              Only {usable.size} of the {SPEEDS.length} speed settings work in this build of the
              engine; the rest are greyed out because they would send a picture nothing can read.
            </div>
          )}

          <div className="notice small" style={{ marginTop: 12 }}>
            <strong>Receiving by screen capture instead of a camera?</strong>
            Then there is no lens to lose anything and you can use{" "}
            <strong>Fastest</strong> — a captured window arrives pixel-perfect. Only do that if
            the other side is really capturing the screen; a camera will not keep up.
          </div>

          {note && (
            <div className="small muted" style={{ marginTop: 10 }}>
              {note}
            </div>
          )}

          {phase === "reading" && (
            <div style={{ marginTop: 14 }}>
              <div className="bar">
                <i style={{ width: `${(readPct * 100).toFixed(1)}%` }} />
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                Streaming from disk · {(readPct * 100).toFixed(0)}%
              </div>
            </div>
          )}
        </div>
      )}

      {manifest && meta && !sending && (
        <div className="panel">
          <h2>2 · Manifest</h2>
          <p className="hint">
            The other screen must end up showing this same 6-character code. Nothing is sent
            back the other way, so comparing these two codes by eye is how you know the file
            arrived intact.
          </p>
          <div className="grid2">
            <dl className="kv">
              <dt>name</dt>
              <dd>{meta.name}</dd>
              <dt>type</dt>
              <dd>{meta.mime}</dd>
              <dt>payload</dt>
              <dd>
                {bytes(payloadSize)} + {envelopeOverhead(meta)} B envelope
              </dd>
              <dt>on the wire</dt>
              <dd>
                {bytes(manifest.totalBytes)} ({int(manifest.totalBytes)} B)
              </dd>
              <dt>chunks</dt>
              <dd>
                {int(manifest.chunkCount)} x {bytes(manifest.chunkSize)}
              </dd>
              <dt>compressed</dt>
              <dd>{manifest.compressed ? "gzip per chunk" : "raw (probe said incompressible)"}</dd>
            </dl>
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>
                display code
              </div>
              <div className="code big">{manifest.displayCode}</div>
            </div>
          </div>
          {plan && plan.capacity > 0 && plan.fill < 0.25 && (
            <div className="notice warn small" style={{ marginTop: 14 }}>
              <strong>Most of this picture is empty, and that is the engine, not a setting.</strong>
              The blocks are drawn as a band across the top of the frame instead of filling it,
              whatever size or quality is chosen. It still sends and decodes correctly — it is
              just harder to read from a distance than it should be. Getting closer helps.
            </div>
          )}

          {plan && plan.capacity > 0 && (
            <div className="small muted" style={{ marginTop: 14 }}>
              The picture is sized to the data: {plan.width} x {plan.height} at{" "}
              <span className="tag" title="internal profile id">
                {plan.profile}
              </span>{" "}
              carries {bytes(plan.capacity)} per picture. Blocks land about{" "}
              <b>{Math.round(plan.screenPitch)} screen pixels</b> across, filling{" "}
              {Math.round(plan.screenCoverage * 100)}% of the display.{" "}
              {plan.shrunk
                ? "Shrunk to fit, then blown up to fill the screen — so the blocks are as big and as readable as they can be."
                : `${int(plan.framesPerPass)} pictures per pass.`}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            {(() => {
              const e = estimate(manifest.totalBytes);
              if (e.singleFrame) {
                return (
                  <div className="notice ok">
                    <strong>One frame. Instant on any camera.</strong>
                    {bytes(manifest.totalBytes)} fits in one picture even at the most forgiving
                    setting, so the screen shows a still image rather than an animation. Nothing
                    flickers and any camera can catch it.
                  </div>
                );
              }
              return (
                <div className={`notice${e.impractical ? " bad" : ""}`}>
                  <strong>
                    {e.impractical
                      ? `This is a ${duration(e.secondsBest)}–${duration(e.secondsWorst)} transfer. Consider sending something smaller.`
                      : `Roughly ${duration(e.secondsBest)} to ${duration(e.secondsWorst)}, depending on the camera.`}
                  </strong>
                  <span className="small">
                    {int(e.framesGood)} pictures on a good hand-held camera ({rate(GOOD_BPS)}), or{" "}
                    {int(e.framesPotato)} on a weak webcam ({rate(POTATO_BPS)}). Both ends of that
                    range are measured, not guessed. A poor camera is slower — never a failure.
                    This side cannot see the receiver, so it is a range and not a countdown; the
                    receiving screen shows the real one.
                  </span>
                </div>
              );
            })()}
          </div>

          {original && isImage(original.meta.mime) && (
            <div className="panel inner" style={{ marginTop: 14 }}>
              <h2>Shrink it first?</h2>
              <p className="hint">
                Photos and screenshots are already compressed, so nothing further can be
                squeezed out of them on the way. Here size is time — re-encoding is usually the
                difference between seconds and minutes. Nothing changes until you press the
                button, and you can always go back to the original.
              </p>
              <div className="row">
                <label className="small muted">
                  quality {Math.round(quality * 100)}%
                  <input
                    type="range"
                    min={0.4}
                    max={0.95}
                    step={0.05}
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                  />
                </label>
                <label className="small muted">
                  max edge{" "}
                  <select value={maxDim} onChange={(e) => setMaxDim(Number(e.target.value))}>
                    <option value={0}>original</option>
                    <option value={2048}>2048 px</option>
                    <option value={1600}>1600 px</option>
                    <option value={1200}>1200 px</option>
                    <option value={800}>800 px</option>
                  </select>
                </label>
                <button className="btn" disabled={working} onClick={() => void applyReencode()}>
                  {working ? "Re-encoding…" : "Re-encode"}
                </button>
                {shrunk && (
                  <button className="btn" onClick={() => void useOriginal()}>
                    Use the original
                  </button>
                )}
              </div>
              <div className="grid2" style={{ marginTop: 12 }}>
                <dl className="kv">
                  <dt>original</dt>
                  <dd>
                    {bytes(original.bytes.length)}
                    {original.dims ? ` · ${original.dims.width}x${original.dims.height}` : ""} ·{" "}
                    {duration(estimate(original.bytes.length).secondsBest)}–
                    {duration(estimate(original.bytes.length).secondsWorst)}
                  </dd>
                </dl>
                <dl className="kv">
                  <dt>{shrunk ? "re-encoded" : "after re-encode"}</dt>
                  <dd>
                    {shrunk
                      ? `${bytes(shrunk.size)} · ${shrunk.width}x${shrunk.height} · ` +
                        `${duration(estimate(shrunk.size).secondsBest)}–${duration(estimate(shrunk.size).secondsWorst)}` +
                        ` · ${(original.bytes.length / Math.max(1, shrunk.size)).toFixed(1)}x smaller`
                      : "—"}
                  </dd>
                </dl>
              </div>
            </div>
          )}

          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={start}>
              Start sending
            </button>
            <span className="small muted">
              The sender loops forever by design. You stop it when the other screen says COMPLETE.
            </span>
          </div>
        </div>
      )}

      <div
        className={`stage${immersive ? " immersive" : ""}`}
        ref={stageRef}
        hidden={!sending}
      >
        {/* THE LETTERBOX STRIPS.
            The frame has a fixed aspect and the viewport almost never matches,
            so there is always dead space beside or above the code. Status lives
            there. Nothing is ever drawn ON the grid — an overlay would corrupt
            the channel. The strips are flex-shrink:0, so if the aspects do
            happen to match, the code gives up a little area rather than the
            status disappearing. */}
        {immersive && (
          <div className="strip strip-top">
            <div className="strip-code" title="compare this with the receiving screen">
              {manifest?.displayCode ?? "—"}
            </div>
            <div className="strip-facts">
              {testPattern && (
                <span>
                  <b>TEST PATTERN</b> — static
                </span>
              )}
              <span>
                <b>{int(stat.frames)}</b> sent
              </span>
              {plan && plan.screenPitch > 0 && (
                <span data-stat="pitch">
                  <b>{Math.round(plan.screenPitch)}px</b> blocks
                </span>
              )}
              <span>
                <b>{duration(stat.elapsed)}</b> elapsed
              </span>
              {framesPerPass > 0 && (
                <span>
                  <b>{int(framesPerPass)}</b> per pass
                </span>
              )}
            </div>
          </div>
        )}

        <div className="canvas-wrap" ref={wrapRef}>
          {/* Nothing is ever drawn on top of this canvas. Every pixel is payload. */}
          <canvas ref={canvasRef} width={1920} height={1080} />
        </div>

        {immersive ? (
          <div className="strip strip-bottom">
            <button className="btn stop" onClick={stop}>
              STOP
            </button>
            <button className="btn ghost" onClick={reset}>
              Reset
            </button>
            <div className="strip-hint">
              Watch the other device. This side cannot see progress.
            </div>
            <button className="btn ghost exit" onClick={exitImmersive} aria-label="Leave full screen">
              ✕
            </button>
          </div>
        ) : (
          <div className="controls">
            <button className="btn stop" onClick={stop}>
              STOP
            </button>
            <div className="stats" style={{ flex: 1, minWidth: 280 }}>
              <div className="stat">
                <div className="k">pictures shown</div>
                <div className="v">{int(stat.frames)}</div>
              </div>
              <div className="stat">
                <div className="k">per second</div>
                <div className="v">{stat.fps}</div>
              </div>
              <div className="stat">
                <div className="k">picture</div>
                <div className="v small">{plan ? `${plan.width}x${plan.height}` : "—"}</div>
              </div>
              <div className="stat">
                <div className="k">one full pass</div>
                <div className="v small">
                  {framesPerPass ? `${int(framesPerPass)} pictures` : "—"}
                </div>
              </div>
              <div className="stat">
                <div className="k">on chunk</div>
                <div className="v">
                  {stat.chunk + 1}/{stat.chunkCount || manifest?.chunkCount || 1}
                </div>
              </div>
              <div className="stat">
                <div className="k">elapsed</div>
                <div className="v">{duration(stat.elapsed)}</div>
              </div>
              <div className="stat">
                <div className="k">display code</div>
                <div className="v small">{manifest?.displayCode ?? "—"}</div>
              </div>
            </div>
            <button className="btn" onClick={reset}>
              Reset
            </button>
            <button className="btn primary" onClick={enterImmersive}>
              Full screen
            </button>
          </div>
        )}
      </div>

      {sending && !immersive && still && (
        <div className="notice ok" style={{ marginTop: 16 }}>
          <strong>It fits in one picture. Nothing is racing past.</strong>
          The whole thing — {bytes(manifest?.totalBytes ?? 0)} — fits in a single picture, so the
          screen holds each one for a moment instead of flickering, and the blocks are as large as
          they can be. Any camera can catch this. Watch the receiving device — this side cannot
          see progress. Leave it up until the other screen reads COMPLETE ✓{" "}
          <span className="mono">{manifest?.displayCode}</span>.
        </div>
      )}

      {sending && !immersive && !still && (
        <div className="notice" style={{ marginTop: 16 }}>
          <strong>Watch the receiving device — this side cannot see progress.</strong>
          Nothing comes back the other way, so this screen genuinely does not know whether anyone
          is watching or how far along they are. All the real status lives on the receiver. It
          keeps broadcasting until you stop it; stop it when the receiving screen reads{" "}
          <span className="mono">COMPLETE ✓ {manifest?.displayCode}</span>.
          {framesPerPass > 0 && (
            <>
              {" "}
              One full pass through the file is {int(framesPerPass)} pictures ({bytes(perFrame)}{" "}
              each), so at {stat.fps || 30} per second a receiver that catches everything is done
              in {duration(framesPerPass / Math.max(1, stat.fps || 30))} —{" "}
              {rate((stat.fps || 30) * perFrame)}. A poorer camera just needs more passes.
            </>
          )}
        </div>
      )}
    </>
  );
}
