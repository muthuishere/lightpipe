import { useCallback, useEffect, useRef, useState } from "react";
import optical from "../optical";
import type { DecodeStats, DoctorReport, FromWorker, ToWorker } from "../worker/protocol";
import {
  listCameras,
  applyCameraMode,
  openCamera,
  openScreen,
  screenCaptureSupported,
  screenLabel,
  type CameraMode,
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
  const [showDetails, setShowDetails] = useState(false);
  /**
   * Auto by default. A real Android capture came back visibly out of focus with
   * focus pinned to manual — sharpness beats stability, and the user can still
   * choose pinning here if their camera hunts badly.
   */
  const [cameraMode, setCameraMode] = useState<CameraMode>("auto");
  /** ADR-0017 preflight: measure the link before committing to a transfer. */
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const doctorMode = useRef(false);

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

  /**
   * CAPTURE MODE. A person aiming a phone at another screen cannot scroll —
   * both hands are holding the device steady. So while capturing, the view is
   * the viewfinder plus the one number that matters, and everything else goes
   * behind a disclosure.
   *
   * Unlike the send side an overlay is free here: the decoder reads the raw
   * camera frame inside the worker, never the pixels we paint on screen.
   */
  const capturing = running && (source === "camera" || source === "screen");


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

  /** Change focus/exposure policy on the live track, without restarting. */
  async function switchCameraMode(mode: CameraMode) {
    setCameraMode(mode);
    const track = streamRef.current?.getVideoTracks()[0];
    if (track) setLock(await applyCameraMode(track, mode));
  }

  // Start playback once the viewfinder is genuinely visible.
  useEffect(() => {
    if (!capturing) return;
    void videoRef.current?.play().catch(() => undefined);
  }, [capturing]);

  /**
   * Lock the page while capturing. Nothing behind the viewfinder may scroll —
   * a person holding a phone steady at another screen cannot scroll anyway, and
   * a stray scroll would move the one number they are reading off the fold.
   */
  useEffect(() => {
    if (!capturing) return;
    document.body.classList.add("immersive-open");
    // The scrolling element is <html>, not <body>, in most engines — locking
    // only the body still lets the page move behind the overlay.
    document.documentElement.classList.add("immersive-open");
    return () => document.body.classList.remove("immersive-open");
      document.documentElement.classList.remove("immersive-open");
  }, [capturing]);

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
        case "doctor":
          setDoctor(m.report);
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

  /** ADR-0017: run the checks instead of a transfer. */
  async function startDoctor() {
    doctorMode.current = true;
    setDoctor(null);
    await start();
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
      // The doctor measures a static pattern, so it always wants the full
      // geometry path — that is one of the things being checked.
      geometry: doctorMode.current ? true : !aligned,
      doctor: doctorMode.current,
      profiles: ["L0", "L1", "L2", "L3", "L4"],
    } satisfies ToWorker);

    if (source === "camera") {
      try {
        const stream = await openCamera(deviceId || undefined);
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        setLock(await applyCameraMode(track, cameraMode));
        setDevices(await listCameras());
        // Attach only. Playback starts from an effect once the element is
        // actually on screen: a display:none <video> never reaches
        // readyState 2, so awaiting play() here silently starved the decoder.
        if (videoRef.current) videoRef.current.srcObject = stream;
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
        if (videoRef.current) videoRef.current.srcObject = stream;
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
    doctorMode.current = false;
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
  /**
   * The honest "need more".
   *
   * The core returns 1 before any header has decoded, which reads as "almost
   * done" when in fact nothing has been seen at all — the user reported exactly
   * that: NEED MORE 1 next to 0 B received and 153 unreadable frames. Until a
   * manifest exists there is no true answer, so say so.
   */
  const haveManifest = Boolean(stats.manifest);
  const needValue = haveManifest && stats.neededMore >= 0 ? stats.neededMore : null;

  /** Four words is about all a person can absorb while holding a phone up. */
  const aimShort =
    stats.quality > 0.75
      ? "Sharp — hold it there"
      : stats.quality > 0.4
        ? "Move closer"
        : "Too soft — get closer";
  const troubleShort =
    stats.lastReason === "bad_crc" ? "Hold steadier — less glare" : "Move closer — fill the frame";

  /**
   * SETUP ONLY. Everything here is static for the length of a scan — which
   * camera, what it pinned, how much room is left. Every LIVE value is on the
   * capture screen itself: when a scan is not working you have to be able to
   * see why without tapping anything.
   */
  function details() {
    return (
      <div className="detail-body">
        {source === "camera" && (
          <div className="detail-block">
            <b>Camera</b>
            <div>
              <label className="small">
                <input
                  type="radio"
                  name="cammode"
                  checked={cameraMode === "auto"}
                  onChange={() => void switchCameraMode("auto")}
                />{" "}
                Autofocus (recommended)
              </label>{" "}
              <label className="small">
                <input
                  type="radio"
                  name="cammode"
                  checked={cameraMode === "pinned"}
                  onChange={() => void switchCameraMode("pinned")}
                />{" "}
                Pinned (advanced)
              </label>
            </div>
            {lock && (
              <>
                <div>{lock.note}</div>
                <div className="muted">
                  now: {lock.achieved?.join(", ") || "not reported"} · applied:{" "}
                  {lock.applied.join(", ") || "none"} · refused:{" "}
                  {lock.refused.join(", ") || "none"} · not offered:{" "}
                  {lock.unsupported.join(", ") || "none"}
                </div>
              </>
            )}
          </div>
        )}

        {running && source === "screen" && (
          <div className="detail-block">
            <b>Capturing {captureLabel ?? "your selection"}</b>
            <div>
              {stats.geometryOn
                ? stats.geometrySkipSupported
                  ? "Searching for the code in the picture. That works whether or not the window is scaled, it just costs more time per frame."
                  : "This build cannot be told to skip the alignment search, so it is doing that work even though a screen grab does not need it. It still decodes correctly — it is simply slower than it has to be."
                : "Reading the grid directly — no alignment search, because a screen grab does not need one."}
            </div>
          </div>
        )}

        {fellBack !== null && (
          <div className="detail-block">
            <b>Turned the alignment search back on</b>
            <div>
              Nothing decoded in the first {fellBack} frames, so the captured window is not a
              straight one-to-one copy of the sending screen — probably windowed or scaled.
              Still decoding, just doing more work per frame.
            </div>
          </div>
        )}

        {noSignal && (
          <div className="detail-block">
            <b>Nothing is decoding</b>
            <div>{noSignal}</div>
          </div>
        )}

        {quota && (
          <div className="detail-block">
            <b>Storage</b>
            <div className="muted">
              {bytes(quota.free)} free of {bytes(quota.quota)}
              {stats.manifest && !quota.enough ? " — not enough for this one" : ""}
            </div>
          </div>
        )}
      </div>
    );
  }

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
        {/* Setup only. While the phone is held up there must be nothing here
            but the viewfinder, the HUD and stop — every extra control pushes
            the one number that matters below the fold. */}
        {!capturing && (
          <div className="notice ok small" style={{ marginBottom: 12 }}>
            <strong>Start here, before the sending device.</strong>
            This side needs aiming and focus settled first. Point it at the other screen, then
            start sending there.
          </div>
        )}
        {!capturing && <h2>1 · Where are the pixels coming from?</h2>}
        {!capturing && (
          <p className="hint">
            Point a camera at the other screen, or — if you are already looking at that machine
            over remote desktop — capture the window directly. Either way the file crosses as
            light, never as a file transfer.
          </p>
        )}
        <div className="row" hidden={capturing}>
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
            <>
              <button
                className="btn primary"
                onClick={() => {
                  doctorMode.current = false;
                  void start();
                }}
              >
                Start receiving
              </button>
              <button className="btn" onClick={() => void startDoctor()}>
                Check my setup
              </button>
            </>
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

        {/* ONE video element for both layouts: only the wrapper's class
            changes, so switching into capture mode never remounts it and never
            drops the MediaStream. */}
        <div className={capturing ? "capture" : "preview-wrap"} hidden={!capturing}>
          <video ref={videoRef} className="capture-video" playsInline muted />

          {capturing && (
            <div className="hud">
              {/* The viewfinder is for AIMING, so it only has to be big enough
                  to see whether the code is in frame. Everything it does not
                  need goes to the numbers, which are what tell you why a scan
                  is not working. */}
              <div className="hud-view">
                <div className="need">
                  <div className="need-value" data-stat="need">
                    {needValue === null ? "—" : int(needValue)}
                  </div>
                  <div className="need-label">
                    {needValue === null ? "looking for a code" : "need more"}
                  </div>
                </div>
              </div>

              {doctorMode.current && doctor ? (
                <div className="hud-status doctor" data-doctor="1">
                  <div className={`doc-verdict ${doctor.verdict}`} data-stat="verdict">
                    {doctor.summary}
                  </div>
                  <ul className="doc-checks">
                    {doctor.checks.map((c) => (
                      <li key={c.id} data-check={c.id} data-pass={String(c.pass)}>
                        <span className={`dot ${c.pass === null ? "wait" : c.pass ? "ok" : "bad"}`} />
                        <b>{c.label}</b>
                        <i>{c.reading}</i>
                        {c.pass === false && <em>{c.remedy}</em>}
                      </li>
                    ))}
                  </ul>
                  {doctor.recommend && (
                    <div className="doc-rec">
                      Recommended speed setting, from what was measured:{" "}
                      <b>{doctor.recommend}</b>
                    </div>
                  )}
                </div>
              ) : (
              <div className="hud-status">
                {/* One short line. A person holding a phone up can take in
                    about four words. */}
                <div className="hud-problem" data-stat="problem">
                  {noSignal ? <b className="bad-text">{troubleShort}</b> : <span>{aimShort}</span>}
                </div>

                <div className={`aim${stats.quality > 0.75 ? " ok" : ""}`} data-stat="quality">
                  <i style={{ width: `${(stats.quality * 100).toFixed(0)}%` }} />
                </div>

                {/* Dense: small labels, compact values, no card chrome. Every
                    live number is on screen at once — nothing to tap open, and
                    nothing to scroll to. */}
                <div className="hud-grid">
                  <div className="hg" data-stat="received">
                    <span>received</span>
                    <b>
                      {bytes(stats.bytesWritten)}
                      {man ? `/${bytes(man.totalBytes)}` : ""}
                    </b>
                  </div>
                  <div className="hg" data-stat="speed">
                    <span>speed</span>
                    <b>{rate(stats.bytesPerSec)}</b>
                  </div>
                  <div className="hg" data-stat="pieces">
                    <span>pieces</span>
                    <b>
                      {int(stats.chunksComplete)}/{int(stats.chunkCount || 0)}
                    </b>
                  </div>
                  <div className="hg" data-stat="left">
                    <span>time left</span>
                    <b>{duration(eta)}</b>
                  </div>
                  <div className="hg" data-stat="rate">
                    <span>frames/s</span>
                    <b>{stats.fps}</b>
                  </div>
                  <div className="hg" data-stat="seen">
                    <span>seen</span>
                    <b>{int(stats.framesSeen)}</b>
                  </div>
                  <div className="hg" data-stat="unreadable">
                    <span>unreadable</span>
                    <b>{int(stats.erasures)}</b>
                  </div>
                  <div className="hg" data-stat="repeats">
                    <span>already had</span>
                    <b>{int(stats.duplicates)}</b>
                  </div>
                </div>
              </div>
              )}

              <div className="hud-bottom">
                <button className="btn stop" onClick={stop}>
                  STOP
                </button>
                {/* Only genuinely static setup lives behind this: the pinned
                    camera settings, free storage, which device. None of it
                    changes while scanning. */}
                <button
                  className="btn ghost"
                  aria-expanded={showDetails}
                  onClick={() => setShowDetails((v) => !v)}
                >
                  {showDetails ? "Hide setup" : "Setup"}
                </button>
              </div>

              {showDetails && <div className="hud-sheet">{details()}</div>}
            </div>
          )}
        </div>

        {/* Not capturing: the same detail, in a normal collapsed disclosure. */}
        {!capturing && (
          <details
            className="details-card"
            open={showDetails}
            onToggle={(e) => setShowDetails((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>Details</summary>
            {details()}
          </details>
        )}
      </div>

      {noSignal && !capturing && (
        <div className="notice bad compact" style={{ marginBottom: 16 }}>
          <strong>{troubleShort}</strong>
          <button className="linkish" onClick={() => void startDoctor()}>
            run Check my setup to find out why
          </button>
        </div>
      )}

      <div className="panel">
        <h2>2 · Coming in</h2>
        <p className="hint">
          The number to watch is <strong>need more</strong>. It should keep falling. Everything
          else is in Details.
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
              {aimShort}
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
            <div className="v">{needValue === null ? "—" : int(needValue)}</div>
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
