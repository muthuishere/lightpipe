/**
 * `wasm-mock.ts` — the in-repo test double for `docs/contracts/wasm-api.md`.
 *
 * WHY IT EXISTS
 * -------------
 * S8 (this app) and S7 (the real wasm bundle) are built in parallel. This mock
 * implements the same frozen surface in pure TypeScript so the UI can be built,
 * typed and *exercised end to end* — sender canvas → receiver → OPFS → saved
 * file — with no wasm and no camera. It stays in the repo permanently as the
 * app's test double.
 *
 * WHAT IT REALLY DOES (it is not a stub that returns fake numbers)
 * ---------------------------------------------------------------
 *  - Splits the input into 256 KB chunks (ADR-0006).
 *  - Emits an endless round-robin block stream per chunk (ADR-0005) — the same
 *    shape as S5's `StubFountain`, i.e. a repeater with NO coding gain.
 *  - Renders each block as a real P8 cell grid (ADR-0003: RGB-cube corners,
 *    3 bits/cell) at 20 px cells — the L0 rung S4 measured for a hand-held
 *    potato camera.
 *  - Guards every frame with a 38-byte header + CRC32. A frame whose CRC fails
 *    is dropped whole and reported as an erasure, never as truth (ADR-0004 /
 *    S2's zero-false-accept property).
 *  - Reconstructs the file from blocks arriving in any order, with duplicates
 *    and gaps.
 *
 * WHERE IT IS DELIBERATELY WEAKER THAN THE REAL CORE — read before trusting a
 * number that came out of it:
 *  1. NO FOUNTAIN CODE. Round-robin repeater, not RaptorQ. With loss it needs
 *     extra passes over the block list; real RaptorQ needs K + ~1 packets
 *     total (S3). So mock frame counts under loss are pessimistic.
 *  2. NO FIDUCIALS / NO HOMOGRAPHY. The decoder assumes the frame it is handed
 *     IS the sender's frame, scaled to fill. Loopback satisfies that exactly;
 *     a real camera does not. This is why the mock cannot stand in for a camera
 *     test (S4 owns rectification).
 *  3. NO GZIP. `compressed` is always false and bytes go raw. `CompressionStream`
 *     is async and this side of the contract is synchronous.
 *  4. NO BLAKE3. `displayCode` / `resumeCode` use a 64-bit FNV-1a. Same shape,
 *     same length, far weaker. Never present a mock display code as integrity.
 *  5. NO LAYERED LADDER. `setProfile` changes the cell size only; there is one
 *     layer in the stream, not the ADR-0011 interleave.
 */

import type {
  FrameView,
  Manifest,
  OpticalModule,
  OpticalReceiver,
  OpticalSender,
  Profile,
  PushResult,
  SenderOptions,
  SenderProgress,
  TakenChunk,
} from "./wasm-api";

/* ------------------------------------------------------------------ memory */

/**
 * Stands in for WASM linear memory. One ArrayBuffer, bump-allocated with an
 * exact-size free list, so the app's ptr/len handling is exercised for real
 * rather than being papered over with JS objects.
 */
class MockMemory {
  buffer: ArrayBuffer;
  private top = 64; // leave a null-ish guard region
  private free = new Map<number, number[]>();

  constructor(bytes = 40 * 1024 * 1024) {
    this.buffer = new ArrayBuffer(bytes);
  }

  alloc(len: number): number {
    const size = (len + 15) & ~15;
    const pool = this.free.get(size);
    const reused = pool?.pop();
    if (reused !== undefined) return reused;
    if (this.top + size > this.buffer.byteLength) {
      throw new Error("mock wasm memory exhausted");
    }
    const ptr = this.top;
    this.top += size;
    return ptr;
  }

  release(ptr: number, len: number): void {
    const size = (len + 15) & ~15;
    const pool = this.free.get(size) ?? [];
    pool.push(ptr);
    this.free.set(size, pool);
  }

  u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.buffer, ptr, len) as Uint8Array;
  }

  u32(ptr: number, len: number): Uint32Array {
    return new Uint32Array(this.buffer, ptr, len);
  }
}

export const memory = new MockMemory();

/* -------------------------------------------------------------- primitives */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Crockford base32, the alphabet ADR-0005's typed codes use. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function crockford(n: number, minLen = 1): string {
  let s = "";
  let v = Math.max(0, Math.floor(n));
  do {
    s = CROCKFORD[v % 32] + s;
    v = Math.floor(v / 32);
  } while (v > 0);
  while (s.length < minLen) s = "0" + s;
  return s;
}

/** 64-bit FNV-1a, standing in for BLAKE3. Same shape, nothing like the strength. */
function fnv1a(bytes: Uint8Array): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bytes[i] + i, 0x85ebca6b) >>> 0;
  }
  return [h1, h2];
}

function sixCharCode(bytes: Uint8Array): string {
  const [a, b] = fnv1a(bytes);
  const mix = ((a ^ (b >>> 7)) >>> 0).toString(32) + (b >>> 0).toString(32);
  let out = "";
  for (let i = 0; i < 6; i++) out += CROCKFORD[parseInt(mix[i] ?? "0", 32) % 32];
  return out;
}

/* --------------------------------------------------------------- geometry */

/**
 * Nominal design frame. All cell coordinates are computed against this and then
 * scaled to whatever the receiver's actual capture resolution is, which is what
 * lets a 1280x720 capture read a 1920x1080 render in loopback.
 */
const NOMINAL_W = 1920;
const NOMINAL_H = 1080;
const HEADER_ROWS = 2;
const HEADER_BYTES = 42; // 38 B of fields + a trailing CRC32

/** ADR-0011 / S4: 20 px is the measured L0 rung for a hand-held potato camera. */
const PROFILE_CELL_PX: Record<Profile, number> = {
  auto: 20,
  L0: 20,
  L1: 14,
  L2: 10,
  L3: 8,
  L4: 6,
};

/** The layer geometries the receiver tries, coarsest first (ADR-0011). */
export const LAYER_CELLS = [20, 14, 10, 8, 6];

export interface Geometry {
  cell: number;
  margin: number;
  cols: number;
  rows: number;
  payloadRows: number;
  /** usable payload bytes per frame, after the header band */
  capacity: number;
}

export function geometryFor(cellPx: number): Geometry {
  const cell = cellPx;
  const marginCells = 4;
  const margin = marginCells * cell;
  const cols = Math.floor((NOMINAL_W - 2 * margin) / cell);
  const rows = Math.floor((NOMINAL_H - 2 * margin) / cell);
  const payloadRows = rows - HEADER_ROWS;
  const capacity = Math.floor((payloadRows * cols * 3) / 8);
  return { cell, margin, cols, rows, payloadRows, capacity };
}

/** P8 — the eight RGB cube corners (ADR-0003). bit0=R, bit1=G, bit2=B. */
function symbolToRgba(sym: number): number {
  const r = sym & 1 ? 255 : 0;
  const g = sym & 2 ? 255 : 0;
  const b = sym & 4 ? 255 : 0;
  // little-endian RGBA packed into one u32
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/* ---------------------------------------------------------------- bit i/o */

function writeSymbols(dst: (i: number, sym: number) => void, src: Uint8Array, count: number) {
  let acc = 0;
  let bits = 0;
  let si = 0;
  for (let i = 0; i < count; i++) {
    while (bits < 3) {
      acc = (acc << 8) | (si < src.length ? src[si] : 0);
      si++;
      bits += 8;
    }
    bits -= 3;
    dst(i, (acc >> bits) & 7);
    acc &= (1 << bits) - 1;
  }
}

function readSymbols(get: (i: number) => number, count: number, out: Uint8Array) {
  let acc = 0;
  let bits = 0;
  let oi = 0;
  for (let i = 0; i < count && oi < out.length; i++) {
    acc = (acc << 3) | (get(i) & 7);
    bits += 3;
    while (bits >= 8 && oi < out.length) {
      bits -= 8;
      out[oi++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
}

/* ----------------------------------------------------------------- header */

interface Header {
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  compressed: boolean;
  displayCode: string;
  chunkIndex: number;
  blockIndex: number;
  blockCount: number;
  payloadLen: number;
  crc?: number;
}

const MAGIC = 0x7451; // "tQ"

function encodeHeader(h: Header, payload: Uint8Array): Uint8Array {
  const b = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, MAGIC, true);
  b[2] = 1; // version
  // 6-byte total length — a u32 would cap the product at 4 GB, and ADR-0008
  // exists precisely because files are multi-GB.
  dv.setUint32(3, h.totalBytes % 0x100000000, true);
  dv.setUint16(7, Math.floor(h.totalBytes / 0x100000000), true);
  dv.setUint32(9, h.chunkSize, true);
  dv.setUint32(13, h.chunkCount, true);
  b[17] = h.compressed ? 1 : 0;
  for (let i = 0; i < 6; i++) b[18 + i] = h.displayCode.charCodeAt(i) & 0x7f;
  dv.setUint32(24, h.chunkIndex, true);
  dv.setUint32(28, h.blockIndex, true);
  dv.setUint32(32, h.blockCount, true);
  dv.setUint16(36, h.payloadLen, true);
  // S2's arbiter: CRC32 over the header fields AND the live payload bytes.
  dv.setUint32(38, frameCrc(b, payload), true);
  return b;
}

/** CRC32 over header bytes 0..37 followed by payload[..payloadLen]. */
function frameCrc(header: Uint8Array, payload: Uint8Array): number {
  const buf = new Uint8Array(38 + payload.length);
  buf.set(header.subarray(0, 38), 0);
  buf.set(payload, 38);
  return crc32(buf);
}

function decodeHeader(b: Uint8Array): Header | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(0, true) !== MAGIC) return null;
  if (b[2] !== 1) return null;
  let displayCode = "";
  for (let i = 0; i < 6; i++) displayCode += String.fromCharCode(b[18 + i]);
  return {
    totalBytes: dv.getUint32(3, true) + dv.getUint16(7, true) * 0x100000000,
    chunkSize: dv.getUint32(9, true),
    chunkCount: dv.getUint32(13, true),
    compressed: b[17] === 1,
    displayCode,
    chunkIndex: dv.getUint32(24, true),
    blockIndex: dv.getUint32(28, true),
    blockCount: dv.getUint32(32, true),
    payloadLen: dv.getUint16(36, true),
    crc: dv.getUint32(38, true),
  };
}

/* ----------------------------------------------------------------- sender */

class MockSender implements OpticalSender {
  private bytes: Uint8Array;
  private opts: Required<SenderOptions>;
  private geo: Geometry;
  private man: Manifest;
  private framePtr: number;
  private frameLen: number;
  private payloadBuf: Uint8Array;
  private chunkIndex = 0;
  private blockIndex = 0;
  private framesEmitted = 0;
  private freed = false;

  private constructor(bytes: Uint8Array, opts: SenderOptions) {
    this.bytes = bytes;
    this.opts = {
      profile: opts.profile ?? "auto",
      chunkSize: opts.chunkSize ?? 262144,
      width: opts.width ?? NOMINAL_W,
      height: opts.height ?? NOMINAL_H,
    };
    this.geo = geometryFor(PROFILE_CELL_PX[this.opts.profile]);
    this.payloadBuf = new Uint8Array(this.geo.capacity);
    this.frameLen = this.opts.width * this.opts.height * 4;
    this.framePtr = memory.alloc(this.frameLen);
    this.man = {
      totalBytes: bytes.length,
      chunkSize: this.opts.chunkSize,
      chunkCount: Math.max(1, Math.ceil(bytes.length / this.opts.chunkSize)),
      // The mock never gzips: CompressionStream is async and this surface is
      // synchronous. The real core probes the first chunk (ADR-0006 / S5).
      compressed: false,
      displayCode: sixCharCode(bytes),
    };
  }

  static create(bytes: Uint8Array, opts: SenderOptions = {}): MockSender {
    return new MockSender(bytes, opts);
  }

  manifest(): Manifest {
    return { ...this.man };
  }

  /** Payload bytes carried per frame at the current profile. */
  blockSize(): number {
    return this.geo.capacity;
  }

  /** Blocks in chunk `i` — the K the receiver must collect for it. */
  blocksInChunk(i: number): number {
    const start = i * this.man.chunkSize;
    const len = Math.min(this.man.chunkSize, this.man.totalBytes - start);
    return Math.max(1, Math.ceil(len / this.geo.capacity));
  }

  nextFrame(): FrameView {
    if (this.freed) throw new Error("sender freed");
    const { chunkSize, totalBytes } = this.man;
    const chunkStart = this.chunkIndex * chunkSize;
    const chunkLen = Math.min(chunkSize, totalBytes - chunkStart);
    const blockCount = this.blocksInChunk(this.chunkIndex);
    const off = chunkStart + this.blockIndex * this.geo.capacity;
    const payloadLen = Math.max(0, Math.min(this.geo.capacity, chunkStart + chunkLen - off));

    this.payloadBuf.fill(0);
    this.payloadBuf.set(this.bytes.subarray(off, off + payloadLen), 0);
    const payload = this.payloadBuf.subarray(0, payloadLen);

    const header = encodeHeader(
      {
        totalBytes,
        chunkSize,
        chunkCount: this.man.chunkCount,
        compressed: this.man.compressed,
        displayCode: this.man.displayCode,
        chunkIndex: this.chunkIndex,
        blockIndex: this.blockIndex,
        blockCount,
        payloadLen,
      },
      payload,
    );

    this.render(header, this.payloadBuf);

    // Round-robin, then advance the chunk, then wrap. Endless (ADR-0005).
    this.blockIndex++;
    if (this.blockIndex >= blockCount) {
      this.blockIndex = 0;
      this.chunkIndex = (this.chunkIndex + 1) % this.man.chunkCount;
    }
    this.framesEmitted++;

    return {
      ptr: this.framePtr,
      len: this.frameLen,
      width: this.opts.width,
      height: this.opts.height,
    };
  }

  private render(header: Uint8Array, payload: Uint8Array) {
    const { width: W, height: H } = this.opts;
    const px = memory.u32(this.framePtr, W * H);
    const WHITE = 0xffffffff;
    px.fill(WHITE);

    const sx = W / NOMINAL_W;
    const sy = H / NOMINAL_H;
    const cw = Math.max(1, Math.round(this.geo.cell * sx));
    const ch = Math.max(1, Math.round(this.geo.cell * sy));
    const ox = Math.round(this.geo.margin * sx);
    const oy = Math.round(this.geo.margin * sy);
    const { cols } = this.geo;

    const paint = (col: number, row: number, sym: number) => {
      const color = symbolToRgba(sym);
      const x0 = ox + col * cw;
      const y0 = oy + row * ch;
      for (let y = 0; y < ch; y++) {
        const base = (y0 + y) * W + x0;
        px.fill(color, base, base + cw);
      }
    };

    // Header band. The 42-byte record is repeated across the whole band, and
    // the decoder accepts the first copy whose CRC validates (S2 — no voting,
    // the CRC is the arbiter).
    const headerCells = HEADER_ROWS * cols;
    writeSymbols(
      (i, sym) => paint(i % cols, Math.floor(i / cols), sym),
      repeatTo(header, Math.ceil((headerCells * 3) / 8)),
      headerCells,
    );

    // Payload band.
    const payloadCells = this.geo.payloadRows * cols;
    writeSymbols(
      (i, sym) => paint(i % cols, HEADER_ROWS + Math.floor(i / cols), sym),
      payload,
      payloadCells,
    );

    // Corner bullseyes, drawn in the quiet zone. The real core detects these to
    // recover the homography (S4); the mock decoder does not use them, they are
    // here so the frame you look at is the frame the real core would produce.
    drawFiducials(px, W, H, Math.round(Math.min(ox, oy) * 0.8));
  }

  progress(): SenderProgress {
    return {
      chunk: this.chunkIndex,
      chunkCount: this.man.chunkCount,
      framesEmitted: this.framesEmitted,
    };
  }

  setProfile(p: Profile): void {
    this.geo = geometryFor(PROFILE_CELL_PX[p]);
    this.payloadBuf = new Uint8Array(this.geo.capacity);
    this.opts.profile = p;
    this.blockIndex = 0;
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    memory.release(this.framePtr, this.frameLen);
  }
}

function repeatTo(src: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += src.length) out.set(src.subarray(0, Math.min(src.length, len - i)), i);
  return out;
}

function drawFiducials(px: Uint32Array, W: number, H: number, side: number) {
  const BLACK = 0xff000000;
  const WHITE = 0xffffffff;
  const s = Math.max(12, side);
  const unit = s / 6;
  const corners: Array<[number, number]> = [
    [4, 4],
    [W - s - 4, 4],
    [4, H - s - 4],
    [W - s - 4, H - s - 4],
  ];
  for (const [cx, cy] of corners) {
    for (let y = 0; y < s; y++) {
      const row = (cy + y) * W;
      for (let x = 0; x < s; x++) {
        const rx = Math.abs(x - s / 2) / unit;
        const ry = Math.abs(y - s / 2) / unit;
        const r = Math.max(rx, ry);
        px[row + cx + x] = r < 0.75 ? BLACK : r < 1.6 ? WHITE : r < 2.6 ? BLACK : WHITE;
      }
    }
  }
}

/* --------------------------------------------------------------- receiver */

interface ChunkState {
  blockCount: number;
  blocks: Map<number, Uint8Array>;
  complete: boolean;
  written: boolean;
}

class MockReceiver implements OpticalReceiver {
  private width: number;
  private height: number;
  private framePtr: number;
  private frameLen: number;
  private geo = geometryFor(PROFILE_CELL_PX.auto);
  private man: Manifest | null = null;
  private chunks = new Map<number, ChunkState>();
  private ready: number[] = [];
  private stagePtr = 0;
  private stageLen = 0;
  private lastQuality = 0;
  private lastGeoCell = PROFILE_CELL_PX.auto;
  private blockSizeSeen = 0;
  private freed = false;
  private symbolBuf: Uint8Array;
  private byteBuf: Uint8Array;
  private chanBuf = new Uint8Array(0);
  private hist = new Uint32Array(256);

  private constructor(opts: { width?: number; height?: number } = {}) {
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.frameLen = this.width * this.height * 4;
    this.framePtr = memory.alloc(this.frameLen);
    this.symbolBuf = new Uint8Array(this.geo.cols * this.geo.rows);
    this.byteBuf = new Uint8Array(this.geo.capacity + HEADER_BYTES * 8);
  }

  static create(opts: { width?: number; height?: number } = {}): MockReceiver {
    return new MockReceiver(opts);
  }

  static resume(
    code: string,
    manifest: Manifest,
    haveChunks: Uint8Array,
  ): MockReceiver | null {
    if (!code || manifest.chunkCount <= 0) return null;
    const r = new MockReceiver({});
    r.man = { ...manifest };
    for (let i = 0; i < manifest.chunkCount; i++) {
      const held = (haveChunks[i >> 3] >> (i & 7)) & 1;
      if (held) {
        // The caller has already re-verified this chunk off disk against the
        // manifest hash (S5). We only need to know not to ask for it again.
        r.chunks.set(i, { blockCount: 1, blocks: new Map(), complete: true, written: true });
      }
    }
    return r;
  }

  frameBuffer(): { ptr: number; len: number } {
    return { ptr: this.framePtr, len: this.frameLen };
  }

  pushFrame(): PushResult {
    if (this.freed) throw new Error("receiver freed");
    const px = memory.u8(this.framePtr, this.frameLen);

    // ADR-0011: the receiver runs one decoder per layer geometry and harvests
    // from whichever it can read. The mock keeps the winning rung and tries it
    // first next frame, which is what makes the steady state cheap.
    const order = [this.lastGeoCell, ...LAYER_CELLS.filter((c) => c !== this.lastGeoCell)];
    let bestQuality = 0;
    let sawMagic = false;

    for (const cellPx of order) {
      const geo = geometryFor(cellPx);
      const { symbols, quality } = this.sample(px, geo);
      if (quality > bestQuality) bestQuality = quality;

      const cols = geo.cols;
      const headerCells = HEADER_ROWS * cols;
      const headerBytes = Math.floor((headerCells * 3) / 8);
      if (this.byteBuf.length < headerBytes) this.byteBuf = new Uint8Array(headerBytes);
      const hb = this.byteBuf.subarray(0, headerBytes);
      readSymbols((i) => symbols[i], headerCells, hb);

      const copies = Math.floor(headerBytes / HEADER_BYTES);
      for (let c = 0; c < copies; c++) {
        const rec = hb.subarray(c * HEADER_BYTES, (c + 1) * HEADER_BYTES);
        const cand = decodeHeader(rec);
        if (!cand) continue;
        sawMagic = true;
        if (cand.payloadLen > geo.capacity) continue;
        const pl = new Uint8Array(cand.payloadLen);
        readSymbolsFrom(symbols, headerCells, geo.payloadRows * cols, pl);
        if (frameCrc(rec, pl) !== cand.crc) continue;
        this.lastGeoCell = cellPx;
        this.geo = geo;
        return this.accept(cand, pl, quality);
      }
    }

    // Not an error. A frame that does not decode is an ERASURE (ADR-0004) —
    // the fountain layer expects them and the UI must never call them failures.
    return {
      accepted: false,
      reason: sawMagic ? "bad_crc" : "no_fiducials",
      neededMore: this.neededMore(),
      quality: bestQuality,
    };
  }

  private accept(header: Header, payload: Uint8Array, quality: number): PushResult {
    this.lastQuality = quality;
    if (header.blockIndex < header.blockCount - 1 && header.payloadLen > 0) {
      this.blockSizeSeen = header.payloadLen;
    }
    if (!this.man) {
      this.man = {
        totalBytes: header.totalBytes,
        chunkSize: header.chunkSize,
        chunkCount: header.chunkCount,
        compressed: header.compressed,
        displayCode: header.displayCode,
      };
    }

    let st = this.chunks.get(header.chunkIndex);
    if (!st) {
      st = { blockCount: header.blockCount, blocks: new Map(), complete: false, written: false };
      this.chunks.set(header.chunkIndex, st);
    }
    if (st.complete || st.blocks.has(header.blockIndex)) {
      return { accepted: false, reason: "duplicate", neededMore: this.neededMore(), quality };
    }

    st.blocks.set(header.blockIndex, payload);
    let chunkComplete: number | undefined;
    if (st.blocks.size >= st.blockCount) {
      st.complete = true;
      this.ready.push(header.chunkIndex);
      chunkComplete = header.chunkIndex;
    }

    const res: PushResult = { accepted: true, neededMore: this.neededMore(), quality };
    if (chunkComplete !== undefined) res.chunkComplete = chunkComplete;
    return res;
  }

  /**
   * Cell sampling. Averages the central 3x3 of each cell and thresholds each
   * channel at mid-scale — the mock's stand-in for the calibration-derived
   * nearest-neighbour of ADR-0003. `quality` is the mean normalised distance of
   * each channel from the threshold: 1.0 = saturated cube corners, 0 = mush.
   */
  private sample(px: Uint8Array, geo: Geometry): { symbols: Uint8Array; quality: number } {
    const { cols, rows, cell, margin } = geo;
    const need = cols * rows;
    if (this.symbolBuf.length < need) this.symbolBuf = new Uint8Array(need);
    if (this.chanBuf.length < need * 3) this.chanBuf = new Uint8Array(need * 3);
    const symbols = this.symbolBuf;
    const chan = this.chanBuf;
    const W = this.width;
    const H = this.height;
    const sx = W / NOMINAL_W;
    const sy = H / NOMINAL_H;

    // Pass 1: mean of the central 3x3 of every cell, per channel.
    let i = 0;
    for (let row = 0; row < rows; row++) {
      const cy = Math.round((margin + (row + 0.5) * cell) * sy);
      for (let col = 0; col < cols; col++) {
        const cx = Math.round((margin + (col + 0.5) * cell) * sx);
        let r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const y = cy + dy < 0 ? 0 : cy + dy >= H ? H - 1 : cy + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx < 0 ? 0 : cx + dx >= W ? W - 1 : cx + dx;
            const o = (y * W + x) * 4;
            r += px[o];
            g += px[o + 1];
            b += px[o + 2];
          }
        }
        chan[i] = (r / 9) | 0;
        chan[i + 1] = (g / 9) | 0;
        chan[i + 2] = (b / 9) | 0;
        i += 3;
      }
    }

    // Pass 2: per-channel auto-level from the frame's own histogram, then a
    // midpoint threshold. This is the mock's stand-in for ADR-0003's real
    // mechanism — a reference fitted from the calibration strip every frame —
    // and it is what lets it survive gain, gamma and white-balance drift
    // instead of assuming the sender's exact 0/255 levels arrive intact.
    const thr = [0, 0, 0];
    const span = [1, 1, 1];
    for (let c = 0; c < 3; c++) {
      const hist = this.hist;
      hist.fill(0);
      for (let k = c; k < need * 3; k += 3) hist[chan[k]]++;
      const cut = Math.max(1, Math.floor(need * 0.02));
      let acc = 0;
      let lo = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= cut) {
          lo = v;
          break;
        }
      }
      acc = 0;
      let hi = 255;
      for (let v = 255; v >= 0; v--) {
        acc += hist[v];
        if (acc >= cut) {
          hi = v;
          break;
        }
      }
      // A channel that is flat carries no information; fall back to mid-scale.
      if (hi - lo < 24) {
        thr[c] = 127;
        span[c] = 128;
      } else {
        thr[c] = (lo + hi) / 2;
        span[c] = (hi - lo) / 2;
      }
    }

    let qsum = 0;
    for (let n = 0, k = 0; n < need; n++, k += 3) {
      const r = chan[k];
      const g = chan[k + 1];
      const b = chan[k + 2];
      symbols[n] = (r > thr[0] ? 1 : 0) | (g > thr[1] ? 2 : 0) | (b > thr[2] ? 4 : 0);
      qsum +=
        (Math.min(1, Math.abs(r - thr[0]) / span[0]) +
          Math.min(1, Math.abs(g - thr[1]) / span[1]) +
          Math.min(1, Math.abs(b - thr[2]) / span[2])) /
        3;
    }
    // Separation alone is not enough: auto-levelling makes a washed-out frame
    // look clean. Scale by the raw dynamic range so a low-contrast camera
    // reads low on the alignment bar, which is what the human needs to see.
    const rawSpan = (span[0] + span[1] + span[2]) / 3;
    const contrast = Math.min(1, rawSpan / 56);
    return { symbols, quality: need ? (qsum / need) * contrast : 0 };
  }

  /** Last measured cell separation, 0..1. Drives the alignment UI. */
  quality(): number {
    return this.lastQuality;
  }

  manifest(): Manifest | null {
    return this.man ? { ...this.man } : null;
  }

  neededMore(): number {
    if (!this.man) return -1; // unknown until the first header decodes
    let missing = 0;
    for (let i = 0; i < this.man.chunkCount; i++) {
      const st = this.chunks.get(i);
      if (!st) {
        // Unseen chunk: we do not know its block count until a header arrives.
        // Estimate from the manifest so the human always has a real number.
        const start = i * this.man.chunkSize;
        const len = Math.min(this.man.chunkSize, this.man.totalBytes - start);
        const bs = this.blockSizeSeen || this.geo.capacity;
        missing += Math.max(1, Math.ceil(len / bs));
      } else if (!st.complete) {
        missing += st.blockCount - st.blocks.size;
      }
    }
    return missing;
  }

  /** ADR-0005 / S5 format: `<chunk>-<need><check>`, Crockford base32. */
  resumeCode(): string {
    if (!this.man) return "";
    let firstIncomplete = this.man.chunkCount;
    for (let i = 0; i < this.man.chunkCount; i++) {
      if (!this.chunks.get(i)?.complete) {
        firstIncomplete = i;
        break;
      }
    }
    const body = `${crockford(firstIncomplete)}-${crockford(Math.max(0, this.neededMore()))}`;
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum = (sum * 31 + body.charCodeAt(i)) >>> 0;
    return body + CROCKFORD[sum % 32];
  }

  displayCode(): string | null {
    return this.man?.displayCode ?? null;
  }

  takeChunk(): TakenChunk | null {
    const index = this.ready.shift();
    if (index === undefined) return null;
    const st = this.chunks.get(index);
    if (!st || !this.man) return null;
    let total = 0;
    for (const [, b] of st.blocks) total += b.length;
    if (this.stageLen < total) {
      if (this.stagePtr) memory.release(this.stagePtr, this.stageLen);
      this.stageLen = total;
      this.stagePtr = memory.alloc(total);
    }
    const dst = memory.u8(this.stagePtr, total);
    let off = 0;
    for (let i = 0; i < st.blockCount; i++) {
      const b = st.blocks.get(i);
      if (!b) return null;
      dst.set(b, off);
      off += b.length;
    }
    st.blocks.clear(); // bounded memory (ADR-0006): the chunk is the caller's now
    st.written = true;
    return { index, ptr: this.stagePtr, len: off };
  }

  isComplete(): boolean {
    if (!this.man) return false;
    for (let i = 0; i < this.man.chunkCount; i++) {
      if (!this.chunks.get(i)?.complete) return false;
    }
    return this.ready.length === 0;
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    memory.release(this.framePtr, this.frameLen);
    if (this.stagePtr) memory.release(this.stagePtr, this.stageLen);
    this.chunks.clear();
  }
}

function readSymbolsFrom(
  symbols: Uint8Array,
  offset: number,
  count: number,
  out: Uint8Array,
) {
  readSymbols((i) => symbols[offset + i], count, out);
}

/* ------------------------------------------------------------ module face */

const mockModule: OpticalModule = {
  init: async () => {},
  memory,
  OpticalSender: MockSender,
  OpticalReceiver: MockReceiver,
  implementation: "mock",
};

export default mockModule;
export { MockSender, MockReceiver };
