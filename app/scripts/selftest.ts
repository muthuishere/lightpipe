/**
 * Headless round trip through the mock: bytes -> frames -> pixels -> bytes.
 * Run with:  npm run selftest
 * No DOM, no camera, no wasm. This is what proves the mock is a real channel
 * and not a stub that returns the answer it was given.
 */
import optical from "../src/optical";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    (globalThis as { process?: { exit(n: number): void } }).process?.exit(1);
  }
}

const SIZE = 700 * 1024;
const src = new Uint8Array(SIZE);
let seed = 12345;
for (let i = 0; i < SIZE; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  src[i] = seed & 0xff;
}

for (const dropRate of [0, 0.3, 0.6]) {
  const sender = optical.OpticalSender.create(src, { chunkSize: 262144 });
  const man = sender.manifest();
  const rx = optical.OpticalReceiver.create({ width: 1280, height: 720 });
  const buf = rx.frameBuffer();
  const out = new Uint8Array(man.totalBytes);
  let frames = 0;
  let erasures = 0;
  let dropped = 0;

  while (!rx.isComplete() && frames < 20000) {
    const f = sender.nextFrame();
    frames++;
    if (Math.random() < dropRate) {
      dropped++;
      continue;
    }
    // "camera": downscale the 1920x1080 render to the 1280x720 capture by
    // nearest-neighbour point sampling. Deliberately lossy resampling.
    const srcPx = new Uint8Array(optical.memory.buffer, f.ptr, f.len);
    const dstPx = new Uint8Array(optical.memory.buffer, buf.ptr, buf.len);
    const dw = 1280, dh = 720;
    for (let y = 0; y < dh; y++) {
      const sy = Math.floor((y * f.height) / dh);
      for (let x = 0; x < dw; x++) {
        const sx = Math.floor((x * f.width) / dw);
        const so = (sy * f.width + sx) * 4;
        const dov = (y * dw + x) * 4;
        dstPx[dov] = srcPx[so];
        dstPx[dov + 1] = srcPx[so + 1];
        dstPx[dov + 2] = srcPx[so + 2];
        dstPx[dov + 3] = 255;
      }
    }
    const r = rx.pushFrame();
    if (!r.accepted && r.reason !== "duplicate") erasures++;
    let taken = rx.takeChunk();
    while (taken) {
      const chunk = new Uint8Array(optical.memory.buffer, taken.ptr, taken.len);
      out.set(chunk.subarray(0, Math.min(taken.len, out.length - taken.index * man.chunkSize)),
        taken.index * man.chunkSize);
      taken = rx.takeChunk();
    }
  }

  assert(rx.isComplete(), `drop=${dropRate}: never completed (${frames} frames)`);
  let diff = 0;
  for (let i = 0; i < SIZE; i++) if (out[i] !== src[i]) diff++;
  assert(diff === 0, `drop=${dropRate}: ${diff} byte mismatches`);
  assert(rx.displayCode() === man.displayCode, "display codes differ");
  console.log(
    `drop=${(dropRate * 100).toFixed(0).padStart(2)}%  frames=${String(frames).padStart(5)}` +
      `  simulated-drops=${String(dropped).padStart(5)}  decode-erasures=${erasures}` +
      `  bytes=${SIZE}  chunks=${man.chunkCount}  code=${man.displayCode}`,
  );
  sender.free();
  rx.free();
}
console.log("mock round trip OK — byte-identical at every drop rate");
