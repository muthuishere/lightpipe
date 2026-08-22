/// <reference lib="webworker" />
/**
 * The decode worker.
 *
 * Everything expensive lives here and NOT on the main thread, for two reasons:
 *  1. ADR-0008 — `createSyncAccessHandle()` only exists in a Worker.
 *  2. Blocking the main thread would collapse the capture frame rate, and the
 *     frame rate is the whole product.
 *
 * The main thread's only job per frame is `createImageBitmap(video)`, and the
 * bitmap is TRANSFERRED here, not copied. Pixel readback, cell sampling, CRC,
 * fountain accumulation and the OPFS write all happen on this side.
 */
import optical from "../optical";
import type { OpticalReceiver } from "../wasm-api";
import type { DecodeStats, FromWorker, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let rx: OpticalReceiver | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let handle: FileSystemSyncAccessHandle | null = null;
let opfsName = "";
let outName = "download.bin";
let capW = 0;
let capH = 0;
/** false when the caller says the frames are already aligned (screen capture) */
let wantGeometry = true;
let geometryFellBack = false;

const stats: DecodeStats = {
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

/** The worker is its own module instance: it must initialise wasm itself. */
const opticalReady = optical.init();

let startedAt = 0;
let lastStatsPost = 0;
let fpsWindow: number[] = [];
let noSignalReported = false;
const reasonCounts: Record<string, number> = {};

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/**
 * Tell the decoder whether it still has to find the grid.
 *
 * A camera frame needs the full fiducial + homography path. A screen capture
 * does not: the pixels are the pixels. If the core cannot be told, we keep the
 * geometry path and record that the saving did NOT happen, so the UI can say
 * so instead of claiming an optimisation it did not get.
 */
function applyGeometry(r: OpticalReceiver) {
  const supported = typeof r.setGeometry === "function";
  stats.geometrySkipSupported = supported;
  if (supported) {
    r.setGeometry?.(wantGeometry);
    stats.geometryOn = wantGeometry;
  } else {
    stats.geometryOn = true;
  }
}

let opfsOpening: Promise<void> | null = null;

/** Delete leftovers from a previous session so OPFS does not accumulate. */
async function purgeStale() {
  try {
    const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & {
      keys?: () => AsyncIterableIterator<string>;
    };
    if (!root.keys) return;
    for await (const name of root.keys()) {
      if (name.startsWith("inflight-") && name.endsWith(".part")) {
        await root.removeEntry(name).catch(() => undefined);
      }
    }
  } catch {
    /* purging is best-effort */
  }
}

async function openOpfs(totalBytes: number) {
  const root = await navigator.storage.getDirectory();
  opfsName = `inflight-${Date.now()}.part`;
  const fh = await root.getFileHandle(opfsName, { create: true });
  handle = await fh.createSyncAccessHandle();
  // Size it up front so out-of-order writes at high offsets are cheap.
  handle.truncate(totalBytes);
}

function writeChunk(index: number, view: Uint8Array, chunkSize: number) {
  if (!handle) return;
  // Random access at the chunk's byte offset — NOT an append. Fountain output
  // arrives out of order and this is exactly the API shape that fits (ADR-0008).
  const at = index * chunkSize;
  // Copy out of wasm linear memory first: the handle must not hold a view into
  // memory that a later wasm call could grow or detach.
  const copy = view.slice();
  handle.write(copy, { at });
  stats.bytesWritten += copy.length;
  post({ type: "chunk", index, bytesWritten: stats.bytesWritten });
}

function refreshStats() {
  if (!rx) return;
  stats.neededMore = rx.neededMore();
  stats.resumeCode = rx.resumeCode();
  stats.displayCode = rx.displayCode();
  stats.manifest = rx.manifest();
  stats.chunkCount = stats.manifest?.chunkCount ?? 0;
  stats.elapsedSec = (performance.now() - startedAt) / 1000;
  stats.bytesPerSec = stats.elapsedSec > 0 ? stats.bytesWritten / stats.elapsedSec : 0;
  const now = performance.now();
  fpsWindow = fpsWindow.filter((t) => now - t < 1000);
  stats.fps = fpsWindow.length;
}

function maybePostStats(force = false) {
  const now = performance.now();
  if (!force && now - lastStatsPost < 100) return;
  lastStatsPost = now;
  refreshStats();
  post({ type: "stats", stats: { ...stats } });
}

/**
 * ADR-0011's loud-and-fast rule. If we have pushed a real number of frames over
 * a real amount of time and not one has decoded, say so with something the
 * human can act on. We keep trying — we just stop pretending it is working.
 */
/**
 * Geometry was skipped on the promise that the frames are aligned. If nothing
 * decodes, that promise was wrong — a windowed or scaled screen share, most
 * likely. Turn geometry back on rather than fail, and tell the user why.
 */
function checkGeometryFallback() {
  if (geometryFellBack || wantGeometry || stats.accepted > 0 || !rx) return;
  if (stats.framesSeen < 25) return;
  geometryFellBack = true;
  wantGeometry = true;
  applyGeometry(rx);
  post({ type: "geometry-fallback", framesTried: stats.framesSeen });
}

function checkNoSignal() {
  if (noSignalReported || stats.accepted > 0) return;
  const seconds = (performance.now() - startedAt) / 1000;
  if (seconds < 6 || stats.framesSeen < 40) return;
  noSignalReported = true;
  const top = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const guidance =
    top === "bad_crc"
      ? "The code is visible but every frame is failing its checksum. Hold the camera steadier, kill any glare or reflection on the sending screen, and raise the room light."
      : "Nothing in view looks like a code. Fill the frame with the sending screen — move closer until it fills the view edge to edge, clean the lens, and make sure the whole screen is inside the frame with a margin all round.";
  post({ type: "no-signal", guidance, framesTried: stats.framesSeen, seconds });
}

async function handleFrame(bitmap: ImageBitmap) {
  try {
    await opticalReady;
    if (!rx) {
      capW = bitmap.width;
      capH = bitmap.height;
      rx = optical.OpticalReceiver.create({ width: capW, height: capH });
      applyGeometry(rx);
      canvas = new OffscreenCanvas(capW, capH);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      startedAt = performance.now();
    }
    if (!ctx || !canvas) return;
    if (bitmap.width !== capW || bitmap.height !== capH) {
      // Capture resolution changed under us (camera renegotiated). Rebuild.
      capW = bitmap.width;
      capH = bitmap.height;
      canvas = new OffscreenCanvas(capW, capH);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      const old = rx;
      rx = optical.OpticalReceiver.create({ width: capW, height: capH });
      applyGeometry(rx);
      old.free();
      if (!ctx) return;
    }

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = ctx.getImageData(0, 0, capW, capH);

    const fb = rx.frameBuffer();
    const dst = new Uint8Array(optical.memory.buffer, fb.ptr, fb.len);
    dst.set(img.data.subarray(0, Math.min(fb.len, img.data.length)));

    stats.framesSeen++;
    fpsWindow.push(performance.now());

    const res = rx.pushFrame();
    stats.quality = res.quality;
    if (res.accepted) {
      stats.accepted++;
      stats.lastReason = null;
    } else if (res.reason === "duplicate") {
      stats.duplicates++;
    } else {
      // NOT an error. An erasure. The fountain layer is built for these.
      stats.erasures++;
      stats.lastReason = res.reason ?? null;
      if (res.reason) reasonCounts[res.reason] = (reasonCounts[res.reason] ?? 0) + 1;
    }

    const man = rx.manifest();
    if (man && !handle) {
      // Several frames can be in flight; only one of them may open the handle.
      opfsOpening = opfsOpening ?? openOpfs(man.totalBytes);
      await opfsOpening;
    }

    if (man) {
      let taken = rx.takeChunk();
      while (taken) {
        const view = new Uint8Array(optical.memory.buffer, taken.ptr, taken.len);
        writeChunk(taken.index, view, man.chunkSize);
        stats.chunksComplete++;
        taken = rx.takeChunk();
      }
    }

    checkGeometryFallback();
    checkNoSignal();

    if (rx.isComplete() && !stats.complete) {
      stats.complete = true;
      refreshStats();
      post({ type: "complete", stats: { ...stats } });
    }
    maybePostStats();
    // Ack every frame so the main thread's in-flight window can drain. Stats
    // are throttled; this is not.
    post({ type: "ack" });
  } catch (err) {
    post({ type: "ack" });
    post({ type: "error", message: String(err) });
  }
}

async function finish() {
  try {
    if (!handle) {
      post({ type: "error", message: "nothing received yet" });
      return;
    }
    handle.flush();
    handle.close();
    handle = null;
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(opfsName);
    const file = await fh.getFile();
    // A File from OPFS is lazily backed — handing it over does not read the
    // whole thing into memory, which is the point on a multi-GB transfer.
    post({ type: "saved", blob: file, fileName: outName, size: file.size });
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      outName = msg.fileName || outName;
      wantGeometry = msg.geometry;
      geometryFellBack = false;
      await opticalReady;
      await purgeStale();
      post({ type: "ready" });
      break;
    case "frame":
      await handleFrame(msg.bitmap);
      break;
    case "finish":
      await finish();
      break;
    case "stop":
      if (handle) {
        try {
          handle.flush();
          handle.close();
        } catch {
          /* already closed */
        }
        handle = null;
      }
      rx?.free();
      rx = null;
      break;
  }
};
