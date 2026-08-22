import { useCallback, useEffect, useRef, useState } from "react";
import optical from "../optical";
import type { DecodeStats, FromWorker, ToWorker } from "../worker/protocol";
import { listCameras, lockAutomatics, openCamera, type LockReport } from "../lib/camera";
import { checkQuota, type QuotaReport } from "../lib/file-source";
import { bytes, duration, int, rate } from "../lib/format";
import { isImage, isMarkdown, isText, unwrapBlob, type EnvelopeMeta } from "../lib/envelope";
import { renderMarkdown } from "../lib/markdown";

type Source = "camera" | "loopback";

interface Sim {
  id: string;
  label: string;
  w: number;
  h: number;
  /** CSS filter chain applied while downscaling — defocus plus photometric drift */
  filter: string;
  drop: number;
}

/**
 * Loopback presets, named after the Rust channel simulator's presets so the two
 * can be talked about in the same words. They are NOT the same model — the real
 * simulator does perspective warp, chroma subsampling, MJPEG artifacts and
 * white-balance drift. This is downscale + defocus + frame drop, which is all a
 * 2D canvas can do cheaply. Treat these as a UI exerciser, not a measurement.
 */
const SIMS: Sim[] = [
  { id: "ideal", label: "ideal — screen grab, no degradation", w: 1920, h: 1080, filter: "none", drop: 0 },
  { id: "good", label: "good — phone camera", w: 1280, h: 720, filter: "blur(0.4px)", drop: 0.02 },
  {
    id: "webcam",
    label: "webcam — soft, washed out, 10% frames lost",
    w: 960,
    h: 540,
    filter: "blur(0.9px) contrast(0.82) brightness(1.06)",
    drop: 0.1,
  },
  {
    id: "potato",
    label: "potato — 640x360, defocused, washed out, 25% frames lost",
    w: 640,
    h: 360,
    filter: "blur(1.2px) contrast(0.66) brightness(1.12) saturate(0.78)",
    drop: 0.25,
  },
  {
    id: "hopeless",
    label: "hopeless — 320x180, unreadable (should fail loudly, ADR-0011)",
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
};

export interface ReceiverProps {
  senderCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  senderActive: boolean;
}

export default function Receiver({ senderCanvasRef, senderActive }: ReceiverProps) {
  const [source, setSource] = useState<Source>("camera");
  const [sim, setSim] = useState("webcam");
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
        case "error":
          setError(m.message);
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
    const w = ensureWorker();
    w.postMessage({ type: "init", fileName: "received.bin" } satisfies ToWorker);

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
    } else if (!senderActive) {
      setError("Start the sender first — loopback reads the sender's own canvas.");
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
      if (source === "camera") {
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
        if (source === "loopback" && preset.filter !== "none") {
          const scratch = scratchRef.current ?? document.createElement("canvas");
          scratchRef.current = scratch;
          scratch.width = preset.w;
          scratch.height = preset.h;
          const sctx = scratch.getContext("2d", { alpha: false });
          if (!sctx) return;
          // The real core finds four corner fiducials and solves a homography,
          // so it needs the screen to sit INSIDE the frame with room around it,
          // exactly as a hand-held camera would see it. The mock has no
          // fiducial detection at all and needs an edge-to-edge grab, so the
          // inset is only applied when the real bundle is loaded.
          const inset = optical.implementation === "wasm" ? Math.round(preset.w * 0.07) : 0;
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
        <h2>1 · Point at the sending screen</h2>
        <p className="hint">
          Decoding runs in a Worker — OPFS sync access handles require one (ADR-0008), and a
          blocked main thread would cost frames.
        </p>
        <div className="row">
          <label className="small muted">
            Source{" "}
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as Source)}
              disabled={running}
            >
              <option value="camera">Camera</option>
              <option value="loopback">Simulated loopback (this tab's sender)</option>
            </select>
          </label>
          {source === "loopback" && (
            <label className="small muted">
              Simulated camera{" "}
              <select value={sim} onChange={(e) => setSim(e.target.value)} disabled={running}>
                {SIMS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
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

        <video
          ref={videoRef}
          className="preview"
          style={{ marginTop: 14, display: source === "camera" && running ? "block" : "none" }}
          playsInline
          muted
        />

        {lock && source === "camera" && (
          <div className="notice small" style={{ marginTop: 14 }}>
            <strong>Camera automatics</strong>
            {lock.note}
            <div className="muted" style={{ marginTop: 6 }}>
              locked: {lock.applied.join(", ") || "none"} · refused:{" "}
              {lock.refused.join(", ") || "none"} · not offered:{" "}
              {lock.unsupported.join(", ") || "none"}
            </div>
          </div>
        )}

        {quota && (
          <div className="small muted" style={{ marginTop: 10 }}>
            Storage: {bytes(quota.free)} free of {bytes(quota.quota)} (OPFS quota, ADR-0008)
            {man && !quota.enough ? " — not enough for this transfer" : ""}
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
        <h2>2 · Live</h2>
        <p className="hint">
          Frames that fail to decode are erasures, not errors — the fountain code is built for
          them (ADR-0004). What matters is that <span className="mono">need more</span> keeps
          falling.
        </p>

        <div className="small muted" style={{ marginBottom: 4 }}>
          alignment / cell separation
        </div>
        <div className={`bar${stats.quality > 0.75 ? " ok" : ""}`}>
          <i style={{ width: `${(stats.quality * 100).toFixed(0)}%` }} />
        </div>
        <div className="small muted" style={{ marginTop: 4, marginBottom: 16 }}>
          {stats.quality > 0.75
            ? "Good separation — hold it there."
            : stats.quality > 0.4
              ? "Marginal. Move closer so the screen fills the frame, and steady the camera."
              : "Poor. The cells are washing into each other — closer, steadier, less glare."}
        </div>

        <div className="stats">
          <div className="stat">
            <div className="k">need more</div>
            <div className="v">{stats.neededMore < 0 ? "—" : int(stats.neededMore)}</div>
          </div>
          <div className="stat">
            <div className="k">chunks</div>
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
            <div className="k">goodput</div>
            <div className="v small">{rate(stats.bytesPerSec)}</div>
          </div>
          <div className="stat">
            <div className="k">decode fps</div>
            <div className="v">{stats.fps}</div>
          </div>
          <div className="stat">
            <div className="k">frames seen</div>
            <div className="v small">{int(stats.framesSeen)}</div>
          </div>
          <div className="stat">
            <div className="k">erasures</div>
            <div className="v small">
              {int(stats.erasures)}{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                normal
              </span>
            </div>
          </div>
          <div className="stat">
            <div className="k">duplicates</div>
            <div className="v small">{int(stats.duplicates)}</div>
          </div>
          <div className="stat">
            <div className="k">eta</div>
            <div className="v small">{duration(eta)}</div>
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
            Compare that against the code on the sending screen. If they match, what you have is
            byte-identical. If they do not, throw it away — there is no acknowledgement protocol,
            this comparison is the integrity check (ADR-0005).
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
            {int(stats.erasures)} did not decode.
          </div>
        </div>
      )}

    </>
  );
}
