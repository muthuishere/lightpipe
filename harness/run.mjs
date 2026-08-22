// S7 — the S0-S5 chain, run through the compiled wasm, in Node, with no browser.
//
//   node harness/run.mjs            full suite + benchmarks
//   node harness/run.mjs --quick    skip the slow simulated-channel cases
//
// What this is actually testing:
//   * the whole stack really runs through `wasm32-unknown-unknown` — encode a
//     payload, push frames through a JS channel simulator, decode, compare bytes;
//   * the hot path is zero-copy in both directions, verified rather than asserted
//     (JS writes into linear memory, wasm reads the same bytes back and vice versa);
//   * the JS<->WASM boundary is priced, per frame, against the same work batched
//     inside wasm — the number ADR-0007 rejected Go on and never measured;
//   * decode throughput at 1920x1080 versus the 15/30 FPS the React app needs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import init, {
  OpticalSender,
  OpticalReceiver,
  benchNoop,
  benchNoopArg,
  benchFrameObject,
  checksumAt,
  frameCapacity,
} from "../app/src/wasm/optical_wasm.js";
import { PRESETS, capture } from "./channel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "app", "src", "wasm", "optical_wasm_bg.wasm");
const QUICK = process.argv.includes("--quick");

const wasm = await init({ module_or_path: readFileSync(WASM) });

// ---------------------------------------------------------------------------
// tiny test harness
// ---------------------------------------------------------------------------

let pass = 0;
const failures = [];
const notes = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}${detail ? "  " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? "  " + detail : ""}`);
  }
}
function eq(name, got, want) {
  check(name, got === want, `got=${got} want=${want}`);
}
function note(s) {
  notes.push(s);
  console.log(`  ..   ${s}`);
}
function section(t) {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const view = (ptr, len) => new Uint8Array(wasm.memory.buffer, ptr, len);

// Same generator as crates/wasm/src/bin/bench_native.rs, so both move identical bytes.
function payload(n, seed) {
  const words = ["the", "optical", "channel", "is", "light", "not", "a", "network",
    "fountain", "chunk", "gzip", "blake3"];
  let x = (seed | 1) >>> 0;
  const out = [];
  const enc = new TextEncoder();
  while (out.length < n) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    for (const b of enc.encode(words[(x >>> 7) % words.length])) out.push(b);
    out.push(x % 11 === 0 ? 10 : 32);
  }
  return new Uint8Array(out.slice(0, n));
}

function fnv1a(bytes) {
  let h = 2166136261 >>> 0;
  for (const b of bytes) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function bitmap(bits, n) {
  const out = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * Run a whole transfer. `channel` is a PRESETS entry or null for a bit-exact loop.
 * Returns the reassembled file plus statistics.
 */
function transfer({ data, w, h, profile, chunkSize = 262144, channel = null,
  dropEvery = 0, maxFrames = 4000, stopAfterChunks = Infinity, rx: reuse = null,
  tx: reuseTx = null, out: reuseOut = null }) {
  const tx = reuseTx ?? OpticalSender.create(data, { profile, chunkSize, width: w, height: h });
  if (!tx) throw new Error("sender create failed");
  const m = tx.manifest();
  const rx = reuse ?? OpticalReceiver.create({ profile, width: w, height: h });
  if (!rx) throw new Error("receiver create failed");
  rx.setGeometry(false); // frames arrive aligned here; rectification is timed separately

  const out = reuseOut ?? new Uint8Array(m.totalBytes);
  const have = new Array(m.chunkCount).fill(false);
  const fb = rx.frameBuffer();
  const scratch = new Uint8Array(w * h * 4);

  let frames = 0, dropped = 0, accepted = 0, completed = 0, lastNeeded = -1;
  let minQuality = 1, rejected = 0;
  while (frames < maxFrames && !rx.isComplete() && completed < stopAfterChunks) {
    const f = tx.nextFrame();
    frames++;
    if (dropEvery && frames % dropEvery === 0) { dropped++; continue; }
    const src = view(f.ptr, f.len);
    const dst = view(fb.ptr, fb.len);
    if (channel) capture(src, dst, w, h, channel, scratch);
    else dst.set(src);
    const r = rx.pushFrame();
    if (r.accepted) accepted++;
    else if (r.reason === "no_fiducials" || r.reason === "bad_crc") rejected++;
    minQuality = Math.min(minQuality, r.quality);
    lastNeeded = r.neededMore;
    if (r.chunkComplete !== undefined) {
      let c;
      while ((c = rx.takeChunk()) !== undefined && c !== null) {
        out.set(view(c.ptr, c.len), c.index * m.chunkSize);
        have[c.index] = true;
        completed++;
      }
    }
  }
  return { tx, rx, m, out, have, frames, dropped, accepted, completed, lastNeeded, minQuality, rejected };
}

// ---------------------------------------------------------------------------
section("1. module + contract surface");
// ---------------------------------------------------------------------------

check("wasm module loads in node (no browser)", typeof wasm.memory?.buffer?.byteLength === "number",
  `linear memory ${(wasm.memory.buffer.byteLength / 1048576).toFixed(1)} MiB`);

{
  const cap = frameCapacity("auto", 1920, 1080);
  eq("frameCapacity('auto',1920x1080) matches artifacts/s4-frontier.csv P8@8px", cap, 8748);

  const tx = OpticalSender.create(payload(1000, 1), {});
  check("OpticalSender.create defaults (1920x1080, 256 KB, auto)", !!tx);
  const m = tx.manifest();
  check("manifest() shape", ["totalBytes", "chunkSize", "chunkCount", "compressed", "displayCode"]
    .every((k) => k in m), JSON.stringify(m));
  eq("manifest.chunkSize is the ADR-0006 default", m.chunkSize, 262144);
  eq("displayCode is 6 chars (ADR-0005)", m.displayCode.length, 6);

  const f = tx.nextFrame();
  check("nextFrame() shape", ["ptr", "len", "width", "height"].every((k) => k in f), JSON.stringify(f));
  eq("frame is RGBA 1920x1080", f.len, 1920 * 1080 * 4);

  const p = tx.progress();
  check("progress() shape", ["chunk", "chunkCount", "framesEmitted"].every((k) => k in p), JSON.stringify(p));

  check("setProfile('L0') accepted", tx.setProfile("L0"));
  check("setProfile('nonsense') returns false, no panic", tx.setProfile("nonsense") === false);
  check("create(empty) returns null, no panic", OpticalSender.create(new Uint8Array(0), {}) === undefined
    || OpticalSender.create(new Uint8Array(0), {}) === null);
  check("create(bad profile) returns null, no panic",
    !OpticalSender.create(payload(100, 1), { profile: "L9" }));
  tx.free();

  const rx = OpticalReceiver.create({});
  check("OpticalReceiver.create defaults", !!rx);
  check("manifest() is null before the first header decodes", !rx.manifest());
  check("displayCode() is null before the first header decodes", !rx.displayCode());
  check("neededMore() > 0 before anything arrives", rx.neededMore() > 0);
  const rc = rx.resumeCode();
  check("resumeCode() is 4-9 chars Crockford (ADR-0005)", /^[0-9A-HJKMNP-TV-Z]{1,4}-[0-9A-HJKMNP-TV-Z]{2,4}$/.test(rc)
    && rc.length >= 4 && rc.length <= 9, rc);
  check("takeChunk() is null with nothing to take", !rx.takeChunk());
  rx.free();
}

// ---------------------------------------------------------------------------
section("2. zero-copy, verified both directions");
// ---------------------------------------------------------------------------

{
  const rx = OpticalReceiver.create({ width: 1920, height: 1080 });
  const a = rx.frameBuffer();
  const b = rx.frameBuffer();
  eq("frameBuffer() ptr is stable across calls", a.ptr, b.ptr);
  eq("frameBuffer() is w*h*4", a.len, 1920 * 1080 * 4);

  // JS -> WASM: write a sentinel through a view on linear memory, have wasm hash
  // the same address range. Equal hashes mean JS wrote into wasm's own memory.
  const buf = view(a.ptr, a.len);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
  eq("JS writes land in WASM linear memory (no copy in)", checksumAt(a.ptr, a.len), fnv1a(buf));

  // WASM -> JS: a view taken *before* the frame is rendered must show the new
  // pixels afterwards. A serialising boundary would hand back a detached snapshot.
  const tx = OpticalSender.create(payload(200000, 3), { width: 1920, height: 1080 });
  // Hash the whole frame, not a window: with a one-symbol source block every repair
  // packet carries the same bytes as the source symbol and differs only in its
  // 4-byte FEC payload ID, so a sampled window can legitimately be identical.
  const f1 = tx.nextFrame();
  const preView = view(f1.ptr, f1.len);
  const before = fnv1a(preView);
  const f2 = tx.nextFrame();
  const after = fnv1a(preView);
  eq("nextFrame() ptr is stable — the buffer is rewritten, not reallocated", f1.ptr, f2.ptr);
  check("a pre-existing JS view sees the new frame (no copy out)", before !== after,
    `fnv ${before} -> ${after}`);
  eq("the view agrees with what WASM sees", checksumAt(f2.ptr, f2.len), fnv1a(view(f2.ptr, f2.len)));

  // No per-frame copy: if frames were serialised across the boundary, 500 of them
  // would move 4.0 GiB. Linear memory must stay flat instead.
  for (let i = 0; i < 200; i++) tx.nextFrame();
  const memBefore = wasm.memory.buffer.byteLength;
  const ptrs = new Set();
  for (let i = 0; i < 500; i++) ptrs.add(tx.nextFrame().ptr);
  const memAfter = wasm.memory.buffer.byteLength;
  const growth = memAfter - memBefore;
  check("500 frames grow linear memory by <1 MiB (a copying boundary needs 4.0 GiB)",
    growth < 1048576, `grew ${growth} B over 500 frames = ${(growth / 500).toFixed(1)} B/frame`);
  eq("500 frames reuse one buffer address", ptrs.size, 1);
  note(`per-frame bytes crossing the boundary: 0 (a 1920x1080 RGBA frame is ${(1920 * 1080 * 4 / 1048576).toFixed(1)} MiB)`);
  tx.free(); rx.free();
}

// ---------------------------------------------------------------------------
section("3. end-to-end through wasm: bit-exact loop, 1920x1080");
// ---------------------------------------------------------------------------

let baseline;
{
  const data = payload(1_200_000, 11);
  const t0 = now();
  const r = transfer({ data, w: 1920, h: 1080, profile: "auto" });
  const ms = now() - t0;
  baseline = r;
  eq("all chunks completed", r.completed, r.m.chunkCount);
  check("isComplete()", r.rx.isComplete());
  eq("neededMore() reaches 0", r.rx.neededMore(), 0);
  eq("sender and receiver display codes match", r.rx.displayCode(), r.m.displayCode);
  check("output is byte-identical to the input",
    r.out.length === data.length && Buffer.compare(Buffer.from(r.out), Buffer.from(data)) === 0);
  eq("receiver manifest matches the sender's", JSON.stringify(r.rx.manifest()), JSON.stringify(r.m));
  note(`${(data.length / 1024).toFixed(0)} KB in ${r.frames} frames over ${r.m.chunkCount} chunks, ` +
    `${r.accepted} accepted, ${ms.toFixed(0)} ms wall`);
  note(`payload efficiency: ${(data.length / (r.frames * 8748) * 100).toFixed(1)}% of the bytes broadcast were useful`);
}

// ---------------------------------------------------------------------------
section("4. erasures: dropped frames are normal, not errors (ADR-0004)");
// ---------------------------------------------------------------------------

{
  const data = payload(600_000, 13);
  const r = transfer({ data, w: 1920, h: 1080, profile: "auto", dropEvery: 3 });
  check("completes with every 3rd frame dropped", r.rx.isComplete());
  eq("neededMore() reaches 0", r.rx.neededMore(), 0);
  check("output is byte-identical", Buffer.compare(Buffer.from(r.out), Buffer.from(data)) === 0);
  note(`${r.dropped}/${r.frames} frames dropped, still exact`);
}

// ---------------------------------------------------------------------------
section("5. resume from a short typed code (ADR-0005/0006)");
// ---------------------------------------------------------------------------

{
  const data = payload(1_200_000, 17);
  const w = 1920, h = 1080;
  const first = transfer({ data, w, h, profile: "auto", stopAfterChunks: 2 });
  const code = first.rx.resumeCode();
  const mb = first.tx.manifestBytes();
  check("partial transfer kept what it had", first.completed === 2, `chunks=${first.completed}/${first.m.chunkCount}`);
  check("resume code is 4-9 chars", code.length >= 4 && code.length <= 9, code);

  // Build the bitmap the way a real caller would: re-verify each retained chunk off
  // "disk" against the manifest BLAKE3, exactly as S5 proved possible.
  const verified = new Array(first.m.chunkCount).fill(false);
  for (let i = 0; i < first.m.chunkCount; i++) {
    if (!first.have[i]) continue;
    const len = Math.min(first.m.chunkSize, first.m.totalBytes - i * first.m.chunkSize);
    verified[i] = first.rx.verifyChunk(i, first.out.subarray(i * first.m.chunkSize, i * first.m.chunkSize + len));
  }
  check("retained chunks re-verify off disk against manifest BLAKE3",
    verified.filter(Boolean).length === first.completed);
  check("a chunk we never received does NOT verify",
    !first.rx.verifyChunk(first.m.chunkCount - 1,
      data.subarray(0, Math.min(first.m.chunkSize, data.length))) || first.have[first.m.chunkCount - 1]);

  const bits = bitmap(verified, first.m.chunkCount);
  const rx2 = OpticalReceiver.resume(code, mb, bits, { width: w, height: h, profile: "auto" });
  check("resume() rebuilds a receiver", !!rx2);
  check("bad resume code is rejected (check character)",
    !OpticalReceiver.resume("ZZ-ZZ", mb, bits, { width: w, height: h }));
  check("garbage manifest is rejected",
    !OpticalReceiver.resume(code, new Uint8Array([1, 2, 3]), bits, { width: w, height: h }));

  const second = transfer({ data, w, h, profile: "auto", rx: rx2, out: first.out });
  check("resumed transfer completes", second.rx.isComplete());
  eq("neededMore() reaches 0 after resume", second.rx.neededMore(), 0);
  check("resumed output is byte-identical",
    Buffer.compare(Buffer.from(second.out), Buffer.from(data)) === 0);
  note(`resumed at "${code}" with ${first.completed}/${first.m.chunkCount} chunks kept; ` +
    `${second.frames} further frames finished it`);
}

// ---------------------------------------------------------------------------
section("6. through the JS channel simulator (a real camera model, in JS)");
// ---------------------------------------------------------------------------

if (QUICK) {
  note("skipped (--quick)");
} else {
  // Smaller frames: the channel simulator is pure JS and a 1080p gaussian blur is
  // seconds per frame. The optical question is per-cell, not per-frame-size.
  const cases = [
    { name: "good",   preset: "good",   w: 1280, h: 720, profile: "L1", bytes: 10000 },
    { name: "webcam", preset: "webcam", w: 1280, h: 720, profile: "L1", bytes: 10000 },
    { name: "potato", preset: "potato", w: 1280, h: 720, profile: "L0", bytes: 4000 },
  ];
  for (const c of cases) {
    const data = payload(c.bytes, 23);
    const t0 = now();
    const r = transfer({
      data, w: c.w, h: c.h, profile: c.profile, chunkSize: 262144,
      channel: PRESETS[c.preset], maxFrames: 400,
    });
    const ms = now() - t0;
    check(`${c.name} camera (${c.profile} @ ${c.w}x${c.h}) completes`, r.rx.isComplete(),
      `${r.frames} frames, ${r.accepted} accepted, ${ms.toFixed(0)} ms`);
    check(`${c.name} output is byte-identical`,
      r.rx.isComplete() && Buffer.compare(Buffer.from(r.out), Buffer.from(data)) === 0);
    eq(`${c.name} neededMore() reaches 0`, r.rx.neededMore(), 0);
    check(`${c.name} frames really were degraded (quality < 1)`, r.minQuality < 1,
      `worst frame quality ${r.minQuality.toFixed(3)}, ${r.rejected} frames rejected`);
    note(`${c.name}: display codes ${r.rx.displayCode() === r.m.displayCode ? "match" : "DIFFER"} (${r.m.displayCode}), ` +
      `${r.frames} frames at ${frameCapacity(c.profile, c.w, c.h)} B/frame`);
  }
}

// ---------------------------------------------------------------------------
section("7. boundary cost: what one JS<->WASM crossing actually costs");
// ---------------------------------------------------------------------------

let boundaryNs = 0;
{
  const timeCall = (fn, n) => {
    for (let i = 0; i < 20000; i++) fn(i); // warm the JIT
    const t0 = now();
    for (let i = 0; i < n; i++) fn(i);
    return ((now() - t0) * 1e6) / n; // ns/call
  };
  const N = 500000;
  const noop = timeCall(() => benchNoop(), N);
  const arg = timeCall((i) => benchNoopArg(i), N);
  const objr = timeCall(() => benchFrameObject(), N / 5);
  note(`benchNoop()               ${noop.toFixed(1)} ns/call`);
  note(`benchNoopArg(u32)->u32    ${arg.toFixed(1)} ns/call`);
  note(`->{ptr,len,width,height}  ${objr.toFixed(1)} ns/call   (what nextFrame/pushFrame return)`);
  boundaryNs = objr;

  // The real measurement: identical work, once per crossing vs batched inside wasm.
  const w = 1920, h = 1080;
  const data = payload(400_000, 29);
  const tx = OpticalSender.create(data, { width: w, height: h });
  const rx = OpticalReceiver.create({ width: w, height: h });
  rx.setGeometry(false);
  const fb = rx.frameBuffer();
  const f = tx.nextFrame();
  view(fb.ptr, fb.len).set(view(f.ptr, f.len));
  rx.pushFrame(); // warm

  // Cross-check: identical work, once per crossing versus batched behind a single
  // crossing. The two are interleaved and each takes its own minimum over 7 rounds,
  // because a 0.6 ms operation on a laptop varies by tens of percent between runs
  // and a naive A-then-B comparison resolves scheduling noise, not the boundary.
  const R = 200;
  const duel = (a, b) => {
    let ma = Infinity, mb = Infinity;
    for (let k = 0; k < 7; k++) {
      let t = now(); a(); ma = Math.min(ma, ((now() - t) * 1e6) / R);
      t = now(); b(); mb = Math.min(mb, ((now() - t) * 1e6) / R);
    }
    return [ma, mb];
  };
  const [perCall, perBatched] =
    duel(() => { for (let i = 0; i < R; i++) rx.pushFrame(); }, () => rx.benchPush(R));
  const decodeDelta = perCall - perBatched;
  const [encPerCall, encPerBatched] =
    duel(() => { for (let i = 0; i < R; i++) tx.nextFrame(); }, () => tx.benchFrames(R));

  note(`decode  per crossing ${(perCall / 1e6).toFixed(3)} ms   batched in wasm ${(perBatched / 1e6).toFixed(3)} ms   ` +
    `delta ${(decodeDelta / 1000).toFixed(2)} us/frame`);
  note(`encode  per crossing ${(encPerCall / 1e6).toFixed(3)} ms   batched in wasm ${(encPerBatched / 1e6).toFixed(3)} ms   ` +
    `delta ${((encPerCall - encPerBatched) / 1000).toFixed(2)} us/frame`);
  // The microbenchmarks above are the trustworthy number: returning the contract's
  // 4-field object is the whole per-frame boundary cost, and it is sub-microsecond.
  // The duel can only confirm the boundary is lost in the noise of the work itself.
  check("per-frame boundary cost is under 1% of a frame's decode work",
    boundaryNs < perCall * 0.01, `${(boundaryNs / 1000).toFixed(2)} us of ${(perCall / 1e6).toFixed(3)} ms ` +
    `= ${(boundaryNs / perCall * 100).toFixed(3)}%`);
  check("batched-vs-per-crossing delta is within measurement noise (no hidden per-call cost)",
    Math.abs(decodeDelta) < perCall * 0.05,
    `${(decodeDelta / perCall * 100).toFixed(2)}% of frame work`);
  tx.free(); rx.free();
}

// ---------------------------------------------------------------------------
section("8. throughput at 1920x1080 (the number S8 needs)");
// ---------------------------------------------------------------------------

{
  const w = 1920, h = 1080, R = 120;
  const data = payload(600_000, 31);
  const tx = OpticalSender.create(data, { width: w, height: h });
  const rx = OpticalReceiver.create({ width: w, height: h });
  const fb = rx.frameBuffer();
  const f = tx.nextFrame();
  view(fb.ptr, fb.len).set(view(f.ptr, f.len));

  rx.setGeometry(false);
  rx.pushFrame();
  let t0 = now();
  for (let i = 0; i < R; i++) rx.pushFrame();
  const decMs = (now() - t0) / R;

  tx.nextFrame();
  t0 = now();
  for (let i = 0; i < R; i++) tx.nextFrame();
  const encMs = (now() - t0) / R;

  // The camera-frame memcpy JS does per frame (drawImage/getImageData equivalent).
  const dst = view(fb.ptr, fb.len);
  const src = view(f.ptr, f.len);
  t0 = now();
  for (let i = 0; i < R; i++) dst.set(src);
  const copyMs = (now() - t0) / R;

  // The rectification path: fiducial detect + lens search + warp + decode.
  const G = 5;
  rx.benchGeometry(1);
  t0 = now();
  const gok = rx.benchGeometry(G);
  const geoMs = (now() - t0) / G;

  const fps = (ms) => 1000 / ms;
  note(`decode, aligned grid     ${decMs.toFixed(3)} ms/frame  = ${fps(decMs).toFixed(1)} FPS`);
  note(`encode (render a frame)  ${encMs.toFixed(3)} ms/frame  = ${fps(encMs).toFixed(1)} FPS`);
  note(`JS RGBA copy into wasm   ${copyMs.toFixed(3)} ms/frame`);
  note(`decode + rectify         ${geoMs.toFixed(1)} ms/frame  = ${fps(geoMs).toFixed(2)} FPS   (fiducials found: ${gok}/${G})`);
  note(`sender+receiver on one thread: ${(1000 / (decMs + encMs + copyMs)).toFixed(1)} FPS`);

  check("aligned decode clears 30 FPS at 1920x1080", fps(decMs) >= 30, `${fps(decMs).toFixed(1)} FPS`);
  check("aligned decode clears 15 FPS at 1920x1080", fps(decMs) >= 15, `${fps(decMs).toFixed(1)} FPS`);
  check("frame render clears 30 FPS at 1920x1080", fps(encMs) >= 30, `${fps(encMs).toFixed(1)} FPS`);
  if (fps(geoMs) < 15) {
    note(`WARNING: the rectification path is ${fps(geoMs).toFixed(2)} FPS — below 15. ` +
      `A hand-held camera needs it on every frame. This is S8's real constraint, not the boundary.`);
  }
  tx.free(); rx.free();
}

// ---------------------------------------------------------------------------
section("9. ADR-0012: one shared symbol size, dense frames, every profile decodes");
// ---------------------------------------------------------------------------
// The sender packs floor(capacity / packet_size) whole fountain packets into each
// frame at ONE symbol size shared across the whole ladder (the coarse rung's), and
// the receiver splits the payload back into packets symmetrically. This section
// proves (a) a data frame is packed near full — not the mostly-black strip the
// per-packet-per-frame framing produced — and (b) every rung completes a round trip.
{
  // The rendered grid geometry, replicated from optical-core's geometry::frame_spec:
  // a fiducial-wide margin (marker + 2*quiet), NOT FrameSpec::new's margin=cell.
  const CELL = { L0: 20, L1: 14, L2: 10, L3: 8, L4: 6, auto: 8 };
  const grid = (w, h, cell) => {
    const marker = Math.min(96, Math.max(72, 8 * cell)); // marker_size clamp
    const margin = marker + 2 * Math.floor(marker / 6);  // + 2*quiet_zone
    return { margin, cols: Math.floor((w - 2 * margin) / cell), rows: Math.floor((h - 2 * margin) / cell) };
  };
  // Fraction of grid cells that render as a non-black (data-bearing) colour. P8 uses
  // black as a legitimate symbol, so a fully packed random frame tops out near ~85%.
  const cellFill = (px, w, h, cell) => {
    const g = grid(w, h, cell);
    let lit = 0, tot = 0;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const x = g.margin + c * cell + (cell >> 1), y = g.margin + r * cell + (cell >> 1);
      const i = (y * w + x) * 4; tot++; if (px[i] | px[i + 1] | px[i + 2]) lit++;
    }
    return 100 * lit / tot;
  };

  // Incompressible payload (an mp4/jpg/zip stand-in, e2e's blob_corpus case): the
  // honest dense-frame test. A coarse rung packs one packet, so its fill reflects the
  // packet's own entropy; only high-entropy bytes exercise the true capacity.
  const blob = (n, seed) => {
    let x = BigInt.asUintN(64, BigInt(seed) || 1n);
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x ^= BigInt.asUintN(64, x << 13n); x ^= x >> 7n; x ^= BigInt.asUintN(64, x << 17n);
      o[i] = Number((x >> 33n) & 0xffn);
    }
    return o;
  };

  const w = 1920, h = 1080;
  const pkt = frameCapacity("L0", w, h); // the one shared packet size
  note(`shared fountain packet size (coarse rung L0): ${pkt} B — one size for the whole ladder (ADR-0012)`);
  const data = blob(600_000, 41);

  for (const prof of ["L0", "L1", "L2", "L3", "L4", "auto"]) {
    const cap = frameCapacity(prof, w, h);
    const perFrame = Math.max(1, Math.floor(cap / pkt));
    // A data frame: skip past the manifest burst so we sample a chunk-carrying frame.
    const tx = OpticalSender.create(data, { profile: prof, width: w, height: h });
    for (let i = 0; i < 40; i++) tx.nextFrame();
    const f = tx.nextFrame();
    const fill = cellFill(view(f.ptr, f.len), w, h, CELL[prof]);
    const capFill = 100 * perFrame * pkt / cap;
    tx.free();

    check(`${prof}: data frame is densely packed (>70% lit cells), not a mostly-black strip`,
      fill > 70, `${fill.toFixed(1)}% lit cells, ${perFrame} packets/frame, ${capFill.toFixed(1)}% of capacity carries packets`);

    const r = transfer({ data, w, h, profile: prof });
    check(`${prof}: byte-identical round trip on the ideal channel`,
      r.rx.isComplete() && Buffer.compare(Buffer.from(r.out), Buffer.from(data)) === 0,
      `${r.frames} frames, ${r.completed}/${r.m.chunkCount} chunks`);
    eq(`${prof}: neededMore() reaches 0`, r.rx.neededMore(), 0);
    eq(`${prof}: display codes match`, r.rx.displayCode(), r.m.displayCode);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"}  ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
