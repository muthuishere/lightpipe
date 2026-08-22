import { useCallback, useEffect, useRef, useState } from "react";
import optical from "../optical";
import type { DecodeStats, FromWorker, ToWorker } from "../worker/protocol";
import {
  listCameras,
  lockAutomatics,
  openCamera,
  openScreen,
  screenCaptureSupported,
  screenLabel,
  type LockReport,
} from "../lib/camera";
import { checkQuota, type QuotaReport } from "../lib/file-source";
import { bytes, duration, int, rate } from "../lib/format";
import { isImage, isMarkdown, isText, unwrapBlob, type EnvelopeMeta } from "../lib/envelope";
import { renderMarkdown } from "../lib/markdown";

type Source = "camera" | "screen" | "loopback";

interface Sim {
  id: string;
  label: string;
  w: number;
  h: number;
  /** CSS filter chain applied while downscaling — defocus plus photometric drift */
  filter: string;
  drop: number;
  /**
   * A pixel-perfect grab: no lens, no perspective, no lighting. Stands in for
   * the screen-capture source, and the decoder can skip finding the grid.
   */
  screenLike?: boolean;
  /**
   * A screen grab of a WINDOW rather than the whole screen: pixel-perfect, but
   * the grid no longer starts where the decoder would assume. Exercises the
   * "skip the alignment search, then discover you could not" fallback.
   */
  windowed?: boolean;
}

/**
 * Loopback presets, named after the Rust channel simulator's presets so the two
 * can be talked about in the same words. They are NOT the same model — the real
 * simulator does perspective warp, chroma subsampling, MJPEG artifacts and
 * white-balance drift. This is downscale + defocus + frame drop, which is all a
 * 2D canvas can do cheaply. Treat these as a UI exerciser, not a measurement.
 */
const SIMS: Sim[] = [
  {
    id: "screen",
    label: "Screen capture — pixel-perfect, nothing lost",
    w: 1920,
    h: 1080,
    filter: "none",
    drop: 0,
    screenLike: true,
  },
  {
    id: "screen-window",
    label: "Screen capture of a window — pixel-perfect but not full screen",
    w: 1920,
    h: 1080,
    filter: "none",
    drop: 0,
    screenLike: true,
    windowed: true,
  },
  { id: "good", label: "Good phone camera", w: 1280, h: 720, filter: "blur(0.4px)", drop: 0.02 },
  {
    id: "webcam",
    label: "Typical webcam — soft, washed out, drops frames",
    w: 960,
    h: 540,
    filter: "blur(0.9px) contrast(0.82) brightness(1.06)",
    drop: 0.1,
  },
  {
    id: "weak",
    label: "Weak webcam — blurry, dim, drops a quarter of frames",
    w: 640,
    h: 360,
    filter: "blur(1.2px) contrast(0.66) brightness(1.12) saturate(0.78)",
    drop: 0.25,
  },
  {
    id: "hopeless",
    label: "Too bad to read — should fail loudly, not hang",
    w: 320,
    h: 180,
    filter: "blur(4px) contrast(0.35) brightness(1.25)",
    drop: 0.4,
  },
];

const EMPTY: DecodeStats = {
  framesSeen: 0,
  accepted: 0,
  erasures: 0,
  duplicates: 0,
  quality: 0,
  neededMore: -1,
  chunksComplete: 0,
  chunkCount: 0,
  bytesWritten: 0,
  resumeCode: "",
  displayCode: null,
  manifest: null,
  fps: 0,
  bytesPerSec: 0,
  elapsedSec: 0,
  complete: false,
  lastReason: null,
  geometryOn: true,
  geometrySkipSupported: false,
};

/**
 * Is this source giving us the sender's own pixels, unaltered?
 *
 * A screen capture is: no lens, no perspective, no lighting, no chroma
 * subsampling. The decoder can sample the grid where it knows the grid is
 * instead of searching for it. A camera never is.
 */
/**
 * The engine reports failures in its own words. Say them in the user's.
 * A receiver that cannot be created is almost always a source that is simply
 * too low-resolution for the grid to survive.
 */
function humanError(raw: string): string {
  if (raw.includes("OpticalReceiver.create")) {
    return (
      "This video source is too low-resolution to read the code from. " +
      "Use a higher-resolution camera, move it closer so the other screen fills the view, " +
      "or capture the screen directly instead of pointing a camera at it."
    );
  }
  if (raw.includes("not initialised")) {
    return "The decoder did not start up. Reload the page and try again.";
  }
  return raw;
}

function isAlignedSource(source: Source, preset: Sim): boolean {
  return source === "screen" || (source === "loopback" && Boolean(preset.screenLike));
}

export interface ReceiverProps {
  senderCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  senderActive: boolean;
}

export default function Receiver({ senderCanvasRef, senderActive }: ReceiverProps) {
  const [source, setSource] = useState<Source>("camera");
  const [sim, setSim] = useState("webcam");
  const [captureLabel, setCaptureLabel] = useState<string | null>(null);
  const [assumeAligned, setAssumeAligned] = useState(true);
  const [fellBack, setFellBack] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<DecodeStats>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [noSignal, setNoSignal] = useState<string | null>(null);
  const [lock, setLock] = useState<LockReport | null>(null);
  const [quota, setQuota] = useState<QuotaReport | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [saved, setSaved] = useState<{ blob: Blob; meta: EnvelopeMeta; size: number } | null>(null);
  const [preview, setPreview] = useState<{ text?: string; url?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [doneChunks, setDoneChunks] = useState<Set<number>>(new Set());

  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const inFlight = useRef(0);
  const runningRef = useRef(false);

  /** Stop capturing. Does NOT touch the worker — the OPFS handle must stay
   *  open long enough to flush and hand the file back. */
  const stopCapture = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Object URLs for image previews are revoked when they are replaced or the
  // view goes away.
  useEffect(() => {
    const url = preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview?.url]);

  useEffect(
    () => () => {
      stopCapture();
      workerRef.current?.postMessage({ type: "stop" } satisfies ToWorker);
      workerRef.current?.terminate();
    },
    [stopCapture],
  );

  useEffect(() => {
    void checkQuota(0).then(setQuota);
  }, []);

  function ensureWorker(): Worker {
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL("../worker/decode.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case "ack":
          inFlight.current = Math.max(0, inFlight.current - 1);
          break;
        case "stats":
          setStats(m.stats);
          break;
        case "chunk":
          setDoneChunks((prev) => new Set(prev).add(m.index));
          break;
        case "complete":
          setStats(m.stats);
          stopCapture();
          setRunning(false);
          // finish() flushes and closes the OPFS handle, then hands back the
          // file. Never send "stop" here — that would close it first.
          w.postMessage({ type: "finish" } satisfies ToWorker);
          break;
        case "no-signal":
          setNoSignal(
            `${m.guidance} (tried ${m.framesTried} frames over ${m.seconds.toFixed(0)}s, nothing decoded)`,
          );
          break;
        case "saved":
          void (async () => {
            const un = await unwrapBlob(m.blob);
            if (un) {
              setSaved({ blob: un.payload, meta: un.meta, size: un.payload.size });
              if (isImage(un.meta.mime)) {
                setPreview({ url: URL.createObjectURL(un.payload) });
              } else if (isText(un.meta.mime) && un.payload.size < 2 * 1024 * 1024) {
                setPreview({ text: await un.payload.text() });
              } else {
                setPreview(null);
              }
            } else {
              // No envelope — treat it as an anonymous binary rather than guess.
              setSaved({
                blob: m.blob,
                meta: { name: m.fileName, mime: "application/octet-stream" },
                size: m.size,
              });
              setPreview(null);
            }
          })();
          break;
        case "geometry-fallback":
          setFellBack(m.framesTried);
          break;
        case "error":
          setError(humanError(m.message));
          break;
        case "ready":
          break;
      }
    };
    workerRef.current = w;
    return w;
  }

  async function start() {
    setError(null);
    setNoSignal(null);
    setSaved(null);
    setStats(EMPTY);
    setDoneChunks(new Set());
    setCaptureLabel(null);
    setFellBack(null);
    const preset = SIMS.find((x) => x.id === sim) ?? SIMS[0];
    const aligned = isAlignedSource(source, preset) && assumeAligned;
    const w = ensureWorker();
    w.postMessage({
      type: "init",
      fileName: "received.bin",
      geometry: !aligned,
    } satisfies ToWorker);

    if (source === "camera") {
      try {
        const stream = await openCamera(deviceId || undefined);
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        setLock(await lockAutomatics(track));
        setDevices(await listCameras());
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play();
        }
      } catch (err) {
        setError(
          `Camera unavailable: ${String(err)}. getUserMedia needs a secure context (https or localhost) and permission.`,
        );
        return;
      }
    } else if (source === "screen") {
      try {
        const stream = await openScreen();
        streamRef.current = stream;
        setCaptureLabel(screenLabel(stream));
        setLock(null);
        // The user can stop the share from the browser's own indicator.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play();
        }
      } catch (err) {
        setError(
          `Screen capture was not started: ${String(err)}. It needs a secure context (https or localhost) and you have to pick a window in the browser's dialog.`,
        );
        return;
      }
    } else if (!senderActive) {
      setError("Start the sender first — the built-in demo reads the sender's own canvas.");
      return;
    }

    runningRef.current = true;
    setRunning(true);
    inFlight.current = 0;
    pump();
  }

  function pump() {
    const preset = SIMS.find((s) => s.id === sim) ?? SIMS[0];
    const tick = async () => {
      if (!runningRef.current) return;
      rafRef.current = requestAnimationFrame(() => void tick());
      if (inFlight.current >= 2) return;

      let src: CanvasImageSource | null = null;
      if (source === "camera" || source === "screen") {
        const v = videoRef.current;
        if (!v || v.readyState < 2) return;
        src = v;
      } else {
        const c = senderCanvasRef.current;
        if (!c || !c.width) return;
        if (Math.random() < preset.drop) return; // simulated frame loss
        src = c;
      }

      try {
        let bitmap: ImageBitmap;
        if (source === "loopback" && (preset.filter !== "none" || preset.windowed)) {
          const scratch = scratchRef.current ?? document.createElement("canvas");
          scratchRef.current = scratch;
          scratch.width = preset.w;
          scratch.height = preset.h;
          const sctx = scratch.getContext("2d", { alpha: false });
          if (!sctx) return;
          // A pixel-perfect source must stay pixel-perfect: smoothing would
          // blur the cell edges we are about to threshold.
          sctx.imageSmoothingEnabled = !preset.screenLike;
          // The real core finds four corner fiducials and solves a homography,
          // so it needs the screen to sit INSIDE the frame with room around it,
          // exactly as a hand-held camera would see it. The mock has no
          // fiducial detection at all and needs an edge-to-edge grab, so the
          // inset is only applied when the real bundle is loaded.
          // A camera sees the screen sitting INSIDE its frame with room around
          // it, and the real core needs that to find the four corner markers.
          // A screen grab has no such margin and needs none — it is the frame.
          const inset =
            preset.windowed || (optical.implementation === "wasm" && !preset.screenLike)
              ? Math.round(preset.w * 0.07)
              : 0;
          sctx.filter = "none";
          sctx.fillStyle = "#101014";
          sctx.fillRect(0, 0, preset.w, preset.h);
          sctx.filter = preset.filter;
          const iw = preset.w - inset * 2;
          const ih = Math.round((iw * 9) / 16);
          sctx.drawImage(src, inset, Math.round((preset.h - ih) / 2), iw, ih);
          bitmap = await createImageBitmap(scratch);
        } else {
          bitmap = await createImageBitmap(src);
        }
        inFlight.current++;
        workerRef.current?.postMessage({ type: "frame", bitmap } satisfies ToWorker, [bitmap]);
      } catch {
        /* a dropped bitmap is an erasure like any other */
      }
    };
    rafRef.current = requestAnimationFrame(() => void tick());
  }

  function stop() {
    stopCapture();
    setRunning(false);
    // Keep whatever completed. ADR-0006: dies at 70% -> you keep 70%.
    workerRef.current?.postMessage({ type: "finish" } satisfies ToWorker);
  }

  async function save() {
    if (!saved) return;
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    if (picker) {
      // Chromium-only fast path. Never the primary path (ADR-0008).
      try {
        const handle = await picker({ suggestedName: saved.meta.name });
        const writable = await (
          handle as unknown as { createWritable(): Promise<WritableStream> }
        ).createWritable();
        await saved.blob.stream().pipeTo(writable);
        return;
      } catch {
        /* fall through to the download that works everywhere */
      }
    }
    const url = URL.createObjectURL(saved.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = saved.meta.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  const activePreset = SIMS.find((x) => x.id === sim) ?? SIMS[0];
  const alignedNow = isAlignedSource(source, activePreset) && !stats.geometryOn;
  const man = stats.manifest;
  const pct = man ? Math.min(1, stats.bytesWritten / Math.max(1, man.totalBytes)) : 0;
  const eta =
    stats.bytesPerSec > 0 && man
      ? (man.totalBytes - stats.bytesWritten) / stats.bytesPerSec
      : NaN;

  return (
    <>
      {error && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          <strong>Receive failed</strong>
          {error}
        </div>
      )}

      <div className="panel">
        <h2>1 · Where are the pixels coming from?</h2>
        <p className="hint">
          Point a camera at the other screen, or — if you are already looking at that machine
          over remote desktop — capture the window directly. Either way the file crosses as
          light, never as a file transfer.
        </p>
        <div className="row">
          <label className="small muted">
            Source{" "}
            <select
              value={source}
              onChange={(e) => {
                const next = e.target.value as Source;
                setSource(next);
                if (next === "loopback") setSim(sim);
              }}
              disabled={running}
            >
              <option value="camera">Camera — point it at the other screen</option>
              <option value="screen" disabled={!screenCaptureSupported()}>
                Screen or window — capture it directly
              </option>
              <option value="loopback">Built-in demo — no hardware needed</option>
            </select>
          </label>
          {source === "loopback" && (
            <label className="small muted">
              Pretend the camera is{" "}
              <select value={sim} onChange={(e) => setSim(e.target.value)} disabled={running}>
                {SIMS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {source === "camera" && devices.length > 1 && (
            <label className="small muted">
              Device{" "}
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={running}
              >
                <option value="">default</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!running ? (
            <button className="btn primary" onClick={() => void start()}>
              Start receiving
            </button>
          ) : (
            <button className="btn" onClick={stop}>
              Stop
            </button>
          )}
        </div>

        {source === "screen" && !running && (
          <div className="notice" style={{ marginTop: 14 }}>
            <strong>Two things to get right when you pick the window.</strong>
            <span className="small">
              Share the window that is <em>showing the code</em> — the remote-desktop window, or
              the whole screen it sits on. And make sure nothing is covering it: anything on top
              of the code is a hole in the picture. Your browser will show its own "you are
              sharing your screen" indicator; that is normal and cannot be turned off.
            </span>
            <div className="small muted" style={{ marginTop: 8 }}>
              A screen capture is pixel-perfect — no lens, no focus, no lighting — so the sending
              side can safely use its fastest setting.
            </div>
            <label className="small muted" style={{ marginTop: 8, display: "block" }}>
              <input
                type="checkbox"
                checked={assumeAligned}
                onChange={(e) => setAssumeAligned(e.target.checked)}
              />{" "}
              Skip the alignment search (faster). Needs the sending window full screen and
              unscaled. If nothing decodes, this turns itself back on.
            </label>
          </div>
        )}

        <video
          ref={videoRef}
          className="preview"
          style={{
            marginTop: 14,
            display: (source === "camera" || source === "screen") && running ? "block" : "none",
          }}
          playsInline
          muted
        />

        {running && source === "screen" && (
          <div className="notice ok small" style={{ marginTop: 14 }}>
            <strong>Capturing {captureLabel ?? "your selection"}</strong>
            {stats.geometryOn
              ? stats.geometrySkipSupported
                ? "Searching for the code in the picture. That works whether or not the window is scaled, it just costs more time per frame."
                : "This build cannot be told to skip the alignment search, so it is doing that work even though a screen grab does not need it. It still decodes correctly — it is simply slower than it has to be."
              : "Reading the grid directly — no alignment search, because a screen grab does not need one."}
          </div>
        )}

        {fellBack !== null && (
          <div className="notice warn small" style={{ marginTop: 14 }}>
            <strong>Turned the alignment search back on.</strong>
            Nothing decoded in the first {fellBack} frames, so the captured window is not a
            straight one-to-one copy of the sending screen — it is probably windowed or scaled.
            Still decoding, just doing more work per frame.
          </div>
        )}

        {lock && source === "camera" && (
          <div className="notice small" style={{ marginTop: 14 }}>
            <strong>Camera settings</strong>
            {lock.note}
            <div className="muted" style={{ marginTop: 6 }}>
              pinned: {lock.applied.join(", ") || "none"} · refused:{" "}
              {lock.refused.join(", ") || "none"} · not offered:{" "}
              {lock.unsupported.join(", ") || "none"}
            </div>
          </div>
        )}

        {quota && (
          <div className="small muted" style={{ marginTop: 10 }}>
            Space for the incoming file: {bytes(quota.free)} free of {bytes(quota.quota)}
            {man && !quota.enough ? " — not enough for this one" : ""}
          </div>
        )}
      </div>

      {noSignal && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          <strong>Nothing is decoding</strong>
          {noSignal}
        </div>
      )}

      <div className="panel">
        <h2>2 · Coming in</h2>
        <p className="hint">
          Some frames will not be readable. That is expected and costs nothing — the sending
          screen keeps repeating until everything has arrived. The only number that matters is
          <strong> need more</strong>, and it should keep falling.
        </p>

        {!alignedNow && (
          <>
            <div className="small muted" style={{ marginBottom: 4 }}>
              picture quality
            </div>
            <div className={`bar${stats.quality > 0.75 ? " ok" : ""}`}>
              <i style={{ width: `${(stats.quality * 100).toFixed(0)}%` }} />
            </div>
            <div className="small muted" style={{ marginTop: 4, marginBottom: 16 }}>
              {stats.quality > 0.75
                ? "Sharp. Hold it there."
                : stats.quality > 0.4
                  ? "Not quite. Move closer so the other screen fills the view, and hold steadier."
                  : "Too soft to read. Get closer, hold still, clean the lens, and kill any glare."}
            </div>
          </>
        )}

        {alignedNow && (
          <div className="small muted" style={{ marginBottom: 16 }}>
            Nothing to line up — the pixels arrive exactly as they were drawn.
          </div>
        )}

        <div className="stats">
          <div className="stat">
            <div className="k">need more</div>
            <div className="v">{stats.neededMore < 0 ? "—" : int(stats.neededMore)}</div>
          </div>
          <div className="stat">
            <div className="k">pieces done</div>
            <div className="v">
              {int(stats.chunksComplete)}/{int(stats.chunkCount || 0)}
            </div>
          </div>
          <div className="stat">
            <div className="k">received</div>
            <div className="v small">
              {bytes(stats.bytesWritten)}
              {man ? ` / ${bytes(man.totalBytes)}` : ""}
            </div>
          </div>
          <div className="stat">
            <div className="k">speed</div>
            <div className="v small">{rate(stats.bytesPerSec)}</div>
          </div>
          <div className="stat">
            <div className="k">time left</div>
            <div className="v small">{duration(eta)}</div>
          </div>
          <div className="stat">
            <div className="k">frames read</div>
            <div className="v">{stats.fps}/s</div>
          </div>
          <div className="stat">
            <div className="k">frames seen</div>
            <div className="v small">{int(stats.framesSeen)}</div>
          </div>
          <div className="stat">
            <div className="k">unreadable</div>
            <div className="v small">
              {int(stats.erasures)}{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                fine
              </span>
            </div>
          </div>
          <div className="stat">
            <div className="k">already had</div>
            <div className="v small">{int(stats.duplicates)}</div>
          </div>
          <div className="stat">
            <div className="k">resume code</div>
            <div className="v small">{stats.resumeCode || "—"}</div>
          </div>
        </div>

        {man && (
          <>
            <div className="bar" style={{ marginTop: 16 }}>
              <i style={{ width: `${(pct * 100).toFixed(1)}%` }} />
            </div>
            {man.chunkCount <= 600 && (
              <div className="chunkmap">
                {Array.from({ length: man.chunkCount }, (_, i) => (
                  <i key={i} className={doneChunks.has(i) ? "done" : ""} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {stats.complete && (
        <div className="panel">
          <h2>3 · Done</h2>
          <div className="notice ok" style={{ marginBottom: 14 }}>
            <strong>COMPLETE ✓ {stats.displayCode ?? "??????"}</strong>
            Check it against the code on the sending screen. If they match, what you have is
            byte-for-byte identical. If they do not, throw it away and start again — comparing
            these two codes by eye is the whole integrity check.
          </div>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="code big">{stats.displayCode ?? "??????"}</div>
            {saved && (
              <span className="small muted">
                <span className="mono">{saved.meta.name}</span> · {saved.meta.mime} ·{" "}
                {bytes(saved.size)}
              </span>
            )}
          </div>

          {!saved && <div className="small muted">Reading it back out of OPFS…</div>}

          {saved && preview?.url && isImage(saved.meta.mime) && (
            <img className="shot" src={preview.url} alt={saved.meta.name} />
          )}

          {saved && preview?.text !== undefined && isMarkdown(saved.meta.mime) && (
            <div
              className="rendered"
              // Safe: renderMarkdown escapes every character of the input first
              // and emits only its own tags. Received bytes are never trusted.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.text) }}
            />
          )}

          {saved && preview?.text !== undefined && !isMarkdown(saved.meta.mime) && (
            <pre className="raw">{preview.text}</pre>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={() => void save()} disabled={!saved}>
              {saved ? `Save ${bytes(saved.size)}` : "Preparing…"}
            </button>
            {preview?.text !== undefined && (
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(preview.text ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy text"}
              </button>
            )}
          </div>

          <div className="small muted" style={{ marginTop: 12 }}>
            Received {bytes(stats.bytesWritten)} in {duration(stats.elapsedSec)} —{" "}
            {rate(stats.bytesPerSec)} across {int(stats.framesSeen)} frames, of which{" "}
            {int(stats.erasures)} could not be read.
          </div>
        </div>
      )}

    </>
  );
}
