import { useCallback, useEffect, useRef, useState } from "react";
import optical from "../optical";
import type { Manifest, OpticalSender, Profile } from "../wasm-api";
import { readFileStreaming, SAFE_LIMIT } from "../lib/file-source";
import { DEFAULT_META, envelopeOverhead, sniff, wrap, type EnvelopeMeta } from "../lib/envelope";
import { bytes, duration, int, rate } from "../lib/format";
import { estimate, GOOD_BPS, POTATO_BPS } from "../lib/estimate";
import { probeImage, reencode, swapExtension } from "../lib/image";
import { isImage } from "../lib/envelope";

type Phase = "idle" | "reading" | "ready" | "sending";
type Input = "file" | "text";

const RESOLUTIONS: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: "1080", label: "1920 x 1080", w: 1920, h: 1080 },
  { id: "720", label: "1280 x 720", w: 1280, h: 720 },
  { id: "match", label: "Match this display", w: 0, h: 0 },
];

const PROFILES: Array<{ id: Profile; label: string }> = [
  { id: "auto", label: "auto (20 px cells — the S4 potato rung)" },
  { id: "L0", label: "L0 — 20 px, any camera" },
  { id: "L1", label: "L1 — 14 px, cheap webcam" },
  { id: "L2", label: "L2 — 10 px, decent webcam" },
  { id: "L3", label: "L3 — 8 px, good webcam / phone" },
  { id: "L4", label: "L4 — 6 px, phone, well lit, steady" },
];

/** Cheap content hash of a frame, used only to detect when the stream repeats. */
function frameHash(ptr: number, len: number): number {
  const words = new Uint32Array(optical.memory.buffer as ArrayBuffer, ptr, len >> 2);
  const step = Math.max(1, Math.floor(words.length / 4096));
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i += step) h = (Math.imul(h ^ words[i], 0x01000193) >>> 0) + i;
  return h >>> 0;
}

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
  const [resolution, setResolution] = useState("1080");
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [still, setStill] = useState(false);
  const [framesPerPass, setFramesPerPass] = useState(0);
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
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

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
      const s = optical.OpticalSender.create(enveloped, { profile, ...dims() });
      senderRef.current?.free();
      senderRef.current = s;
      setManifest(s.manifest());
      setPhase("ready");
    },
    // dims() reads refs and state at call time; profile is the only real dep
    [profile],
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
            `ADR-0008 wants multi-GB; the contract needs a chunk-fed sender before that is real.`,
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

  function dims() {
    const r = RESOLUTIONS.find((x) => x.id === resolution)!;
    if (r.w) return { width: r.w, height: r.h };
    const dpr = window.devicePixelRatio || 1;
    const aw = Math.floor((stageRef.current?.clientWidth ?? window.innerWidth) * dpr);
    const ah = Math.floor(window.innerHeight * dpr);
    let w = Math.max(960, Math.min(aw, Math.floor((ah * 16) / 9)));
    w -= w % 2;
    return { width: w, height: Math.floor((w * 9) / 16) };
  }

  function rebuildSender() {
    const data = bytesRef.current;
    if (!data) return null;
    senderRef.current?.free();
    const s = optical.OpticalSender.create(data, { profile, ...dims() });
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
    const t0 = performance.now();
    let frames = 0;
    let firstHash = -1;
    let period = 0;
    const window1s: number[] = [];

    const tick = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
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

      // Detect when the endless stream has come all the way round. A payload
      // small enough to fit one frame has period 1, and animating a single
      // still image would only make it harder to capture.
      if (period === 0 && frames < 4096) {
        const h = frameHash(f.ptr, f.len);
        if (firstHash < 0) {
          firstHash = h;
        } else if (h === firstHash) {
          period = frames;
          setFramesPerPass(period);
          if (period === 1) {
            setStill(true);
            rafRef.current = 0;
            return; // the frame on screen IS the whole transmission
          }
        }
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

  function stop() {
    stopLoop();
    setPhase("ready");
    setStill(false);
    onSendingChange(false);
    if (document.fullscreenElement) void document.exitFullscreen();
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
              Layer{" "}
              <select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
                {PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="small muted">
              Frame{" "}
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                {RESOLUTIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
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
            The receiver must end up showing the same 6-character code. That comparison is the
            integrity check — there is no acknowledgement protocol (ADR-0005).
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
          <div style={{ marginTop: 16 }}>
            {(() => {
              const e = estimate(manifest.totalBytes);
              if (e.singleFrame) {
                return (
                  <div className="notice ok">
                    <strong>One frame. Instant on any camera.</strong>
                    {bytes(manifest.totalBytes)} fits inside a single frame even at the coarsest
                    measured rung, so the screen shows one still image rather than an animation.
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
                    {int(e.framesGood)} frames on a good hand-held camera ({rate(GOOD_BPS)}) and{" "}
                    {int(e.framesPotato)} on a potato webcam ({rate(POTATO_BPS)}), both at 15 FPS.
                    Those two ends are S4's measured warped frontier, not a guess — and a bad
                    camera is slower, never a failure (ADR-0011). The sender cannot see the
                    receiver, so this is a range and not a countdown; the receiving screen shows
                    the real one.
                  </span>
                </div>
              );
            })()}
          </div>

          {original && isImage(original.meta.mime) && (
            <div className="panel inner" style={{ marginTop: 14 }}>
              <h2>Shrink it first?</h2>
              <p className="hint">
                gzip cannot shrink an already-compressed image (ADR-0014 compresses it anyway,
                and gains nothing). On this channel size is time — re-encoding to WebP is
                usually the difference between seconds and minutes. Nothing is applied until
                you press the button.
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

      <div className={`stage${fullscreen ? " fs" : ""}`} ref={stageRef} hidden={!sending}>
        {/* Nothing is ever drawn on top of this canvas. Every pixel is payload. */}
        <canvas ref={canvasRef} width={1920} height={1080} />
        <div className="controls">
          <button className="btn stop" onClick={stop}>
            STOP
          </button>
          <div className="stats" style={{ flex: 1, minWidth: 320 }}>
            <div className="stat">
              <div className="k">{still ? "frames" : "frames sent"}</div>
              <div className="v">{still ? "1 — still" : int(stat.frames)}</div>
            </div>
            <div className="stat">
              <div className="k">fps</div>
              <div className="v">{still ? "—" : stat.fps}</div>
            </div>
            <div className="stat">
              <div className="k">one pass</div>
              <div className="v small">
                {framesPerPass ? `${int(framesPerPass)} frames` : "measuring…"}
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
          {!fullscreen && (
            <button className="btn" onClick={() => void stageRef.current?.requestFullscreen?.()}>
              Full screen
            </button>
          )}
        </div>
      </div>

      {sending && !fullscreen && still && (
        <div className="notice ok" style={{ marginTop: 16 }}>
          <strong>One frame. Nothing is animating, and that is correct.</strong>
          The whole payload — {bytes(manifest?.totalBytes ?? 0)} — fits in a single frame at this
          layer, so there is nothing to loop. A still image is far easier for a camera to catch
          than a flicker. Leave it up until the other screen reads COMPLETE ✓{" "}
          <span className="mono">{manifest?.displayCode}</span>.
        </div>
      )}

      {sending && !fullscreen && !still && (
        <div className="notice" style={{ marginTop: 16 }}>
          <strong>This is not stuck — it is supposed to run forever.</strong>
          There is no back-channel (ADR-0005). The sender re-broadcasts an endless stream of
          distinct coded blocks and has no idea whether anyone is watching. Stop it when the
          receiving screen reads <span className="mono">COMPLETE ✓ {manifest?.displayCode}</span>.
          {framesPerPass > 0 && (
            <>
              {" "}
              One full pass is {int(framesPerPass)} frames ≈ {bytes(perFrame)} per frame, so at{" "}
              {stat.fps || 30} fps a clean receiver finishes a pass in{" "}
              {duration(framesPerPass / Math.max(1, stat.fps || 30))} —{" "}
              {rate((stat.fps || 30) * perFrame)}. A bad camera needs more passes; it still
              finishes (ADR-0011).
            </>
          )}
        </div>
      )}
    </>
  );
}
