// A JS port of `crates/core/src/sim.rs` — "screen -> air -> webcam" (ADR-0009).
//
// Ported rather than called through wasm on purpose: the S7 question is whether the
// wasm boundary breaks anything, and that is only a real test if the *other* side of
// the boundary is genuinely JS. So the degradations a camera applies happen in JS,
// writing straight into the receiver's wasm frame buffer, exactly as `getUserMedia`
// + `drawImage` + `getImageData` will in S8.
//
// Faithful to sim.rs including the xorshift PRNG, so a JS run and a Rust run of the
// same preset produce the same pixels. Geometry (yaw/pitch/roll/barrel) and the
// rolling-shutter tear are NOT ported: they are `apply_pair`/`warp` territory and the
// rectification path is exercised separately.
//
// Buffers are RGBA (canvas ImageData layout). Alpha is carried through untouched.

export const PRESETS = {
  ideal: {
    gain: [1, 1, 1], gamma: 1, blur: 0, resample: 1,
    chroma420: false, jpeg: 0, noise: 0, vignette: 0, seed: 0x5EED1234,
  },
  good: {
    gain: [1.02, 1.0, 0.97], gamma: 1.05, blur: 0.6, resample: 0.9,
    chroma420: true, jpeg: 0.1, noise: 2.0, vignette: 0.05, seed: 0x5EED1234,
  },
  webcam: {
    gain: [1.08, 1.0, 0.90], gamma: 1.15, blur: 1.1, resample: 0.7,
    chroma420: true, jpeg: 0.25, noise: 5.0, vignette: 0.15, seed: 0x5EED1234,
  },
  potato: {
    gain: [1.18, 1.0, 0.80], gamma: 1.35, blur: 2.0, resample: 0.42,
    chroma420: true, jpeg: 0.55, noise: 11.0, vignette: 0.32, seed: 0x5EED1234,
  },
};

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

class Rng {
  constructor(seed) { this.x = (seed | 1) >>> 0; }
  nextU32() {
    let x = this.x;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.x = x;
    return x;
  }
  unit() { return (this.nextU32() >>> 8) / 16777216; }
  // Irwin-Hall approximation of a normal, exactly as sim.rs does it.
  normal() { return (this.unit() + this.unit() + this.unit() + this.unit() - 2) * 1.732; }
}

function response(buf, gain, gamma) {
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = buf[i + c] / 255;
      buf[i + c] = clamp8(Math.pow(v, gamma) * gain[c] * 255);
    }
  }
}

function vignette(buf, w, h, strength) {
  const cx = w / 2, cy = h / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      const f = 1 - strength * r * r;
      const i = (y * w + x) * 4;
      buf[i] = clamp8(buf[i] * f);
      buf[i + 1] = clamp8(buf[i + 1] * f);
      buf[i + 2] = clamp8(buf[i + 2] * f);
    }
  }
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
}

function blur(buf, w, h, sigma, scratch) {
  const k = gaussianKernel(sigma);
  const radius = (k.length / 2) | 0;
  const tmp = scratch;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let j = 0; j < k.length; j++) {
        let sx = x + j - radius;
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
        const i = (y * w + sx) * 4;
        a0 += buf[i] * k[j]; a1 += buf[i + 1] * k[j]; a2 += buf[i + 2] * k[j];
      }
      const o = (y * w + x) * 4;
      tmp[o] = clamp8(a0); tmp[o + 1] = clamp8(a1); tmp[o + 2] = clamp8(a2);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a0 = 0, a1 = 0, a2 = 0;
      for (let j = 0; j < k.length; j++) {
        let sy = y + j - radius;
        sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
        const i = (sy * w + x) * 4;
        a0 += tmp[i] * k[j]; a1 += tmp[i + 1] * k[j]; a2 += tmp[i + 2] * k[j];
      }
      const o = (y * w + x) * 4;
      buf[o] = clamp8(a0); buf[o + 1] = clamp8(a1); buf[o + 2] = clamp8(a2);
    }
  }
}

function meanRect(buf, w, x0, y0, rw, rh) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

// Downsample to the sensor's real resolution and back up. The detail lost in
// between is what a low-res camera throws away.
function resampleRoundtrip(buf, w, h, factor) {
  const sw = Math.max(2, (w * factor) | 0);
  const sh = Math.max(2, (h * factor) | 0);
  const small = new Float64Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const x0 = ((x * w) / sw) | 0;
      const y0 = ((y * h) / sh) | 0;
      const x1 = Math.min(w, Math.max(x0 + 1, (((x + 1) * w) / sw) | 0));
      const y1 = Math.min(h, Math.max(y0 + 1, (((y + 1) * h) / sh) | 0));
      const m = meanRect(buf, w, x0, y0, x1 - x0, y1 - y0);
      const o = (y * sw + x) * 3;
      small[o] = clamp8(m[0]); small[o + 1] = clamp8(m[1]); small[o + 2] = clamp8(m[2]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) * sw) / w - 0.5;
      const fy = ((y + 0.5) * sh) / h - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = Math.min(1, Math.max(0, fx - x0));
      const ty = Math.min(1, Math.max(0, fy - y0));
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = small[(y0 * sw + x0) * 3 + c];
        const b = small[(y0 * sw + x1) * 3 + c];
        const cc = small[(y1 * sw + x0) * 3 + c];
        const d = small[(y1 * sw + x1) * 3 + c];
        const top = a * (1 - tx) + b * tx;
        const bot = cc * (1 - tx) + d * tx;
        buf[o + c] = clamp8(top * (1 - ty) + bot * ty);
      }
    }
  }
}

// YUV 4:2:0 — luma full resolution, chroma box-averaged 2x2 and replicated back.
// The single most important degradation for a colour design (ADR-0003).
function chroma420(buf, w, h) {
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  for (let by = 0; by < h; by += 2) {
    for (let bx = 0; bx < w; bx += 2) {
      let sb = 0, sr = 0, cnt = 0;
      for (let y = by; y < Math.min(by + 2, h); y++) {
        for (let x = bx; x < Math.min(bx + 2, w); x++) { sb += Cb[y * w + x]; sr += Cr[y * w + x]; cnt++; }
      }
      const mb = sb / cnt, mr = sr / cnt;
      for (let y = by; y < Math.min(by + 2, h); y++) {
        for (let x = bx; x < Math.min(bx + 2, w); x++) { Cb[y * w + x] = mb; Cr[y * w + x] = mr; }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const y = Y[i], u = Cb[i], v = Cr[i];
    buf[i * 4] = clamp8(y + 1.402 * v);
    buf[i * 4 + 1] = clamp8(y - 0.344136 * u - 0.714136 * v);
    buf[i * 4 + 2] = clamp8(y + 1.772 * u);
  }
}

// Crude MJPEG stand-in: lerp each pixel toward its 8x8 block mean.
function blockiness(buf, w, h, amount) {
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const bw = Math.min(bx + 8, w) - bx;
      const bh = Math.min(by + 8, h) - by;
      const m = meanRect(buf, w, bx, by, bw, bh);
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) buf[i + c] = clamp8(buf[i + c] * (1 - amount) + m[c] * amount);
        }
      }
    }
  }
}

function addNoise(buf, sigma, seed) {
  const rng = new Rng(seed);
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 3; c++) buf[i + c] = clamp8(buf[i + c] + rng.normal() * sigma);
  }
}

/**
 * Capture `src` (RGBA) into `dst` (RGBA), applying the channel. `dst` is normally a
 * view straight into the receiver's wasm frame buffer, so the "camera" writes into
 * WASM linear memory with no intermediate array — exactly the S8 data flow.
 */
export function capture(src, dst, w, h, ch, scratch) {
  dst.set(src);
  if (ch.gamma !== 1 || ch.gain[0] !== 1 || ch.gain[1] !== 1 || ch.gain[2] !== 1) {
    response(dst, ch.gain, ch.gamma);
  }
  if (ch.vignette > 0) vignette(dst, w, h, ch.vignette);
  if (ch.blur > 0) blur(dst, w, h, ch.blur, scratch);
  if (ch.resample < 0.999) resampleRoundtrip(dst, w, h, ch.resample);
  if (ch.chroma420) chroma420(dst, w, h);
  if (ch.jpeg > 0) blockiness(dst, w, h, ch.jpeg);
  if (ch.noise > 0) addNoise(dst, ch.noise, ch.seed);
  return dst;
}
