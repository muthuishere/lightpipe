//! Channel simulator: stands in for "screen -> air -> webcam" (ADR-0009).
//! Deterministic — the PRNG is seeded — so every result is reproducible.

use crate::image::RgbImage;

#[derive(Clone, Copy, Debug)]
pub struct Channel {
    /// Per-channel gain (white-balance drift). 1.0 = neutral.
    pub gain: [f32; 3],
    /// Display + camera response curve. 1.0 = linear.
    pub gamma: f32,
    /// Defocus, in pixels of standard deviation.
    pub blur_sigma: f32,
    /// Effective sensor resolution as a fraction of the rendered frame.
    /// 1.0 = pixel-perfect; 0.45 = a cheap 480p webcam looking at a 1080p screen.
    pub resample: f32,
    /// Webcams deliver YUV 4:2:0 — chroma at half resolution in both axes.
    pub chroma_420: bool,
    /// Crude MJPEG stand-in: lerp each pixel toward its 8x8 block mean.
    /// Approximate; real JPEG arrives with the S6 capture fixtures.
    pub jpeg: f32,
    /// Gaussian sensor noise, in 0-255 units of standard deviation.
    pub noise: f32,
    /// Corner falloff. 0.0 = none, 0.4 = heavy vignette.
    pub vignette: f32,
    pub seed: u32,
}

impl Default for Channel {
    fn default() -> Self {
        Self {
            gain: [1.0, 1.0, 1.0],
            gamma: 1.0,
            blur_sigma: 0.0,
            resample: 1.0,
            chroma_420: false,
            jpeg: 0.0,
            noise: 0.0,
            vignette: 0.0,
            seed: 0x5EED_1234,
        }
    }
}

impl Channel {
    /// A perfect channel. S0 uses this.
    pub fn ideal() -> Self {
        Self::default()
    }

    /// A good phone camera, well lit, steady.
    pub fn good() -> Self {
        Self {
            blur_sigma: 0.6,
            resample: 0.9,
            chroma_420: true,
            jpeg: 0.1,
            noise: 2.0,
            gain: [1.02, 1.0, 0.97],
            gamma: 1.05,
            vignette: 0.05,
            ..Self::default()
        }
    }

    /// A normal laptop webcam.
    pub fn webcam() -> Self {
        Self {
            blur_sigma: 1.1,
            resample: 0.7,
            chroma_420: true,
            jpeg: 0.25,
            noise: 5.0,
            gain: [1.08, 1.0, 0.90],
            gamma: 1.15,
            vignette: 0.15,
            ..Self::default()
        }
    }

    /// The potato (ADR-0011). Cheap fixed-focus sensor, bad light, hard MJPEG,
    /// drifting white balance. This one is binding: some layer must still decode.
    pub fn potato() -> Self {
        Self {
            blur_sigma: 2.0,
            resample: 0.42,
            chroma_420: true,
            jpeg: 0.55,
            noise: 11.0,
            gain: [1.18, 1.0, 0.80],
            gamma: 1.35,
            vignette: 0.32,
            ..Self::default()
        }
    }

    pub fn named() -> Vec<(&'static str, Channel)> {
        vec![
            ("ideal", Self::ideal()),
            ("good", Self::good()),
            ("webcam", Self::webcam()),
            ("potato", Self::potato()),
        ]
    }

    pub fn apply(&self, src: &RgbImage) -> RgbImage {
        let mut img = src.clone();
        apply_response(&mut img, self.gain, self.gamma);
        if self.vignette > 0.0 {
            apply_vignette(&mut img, self.vignette);
        }
        if self.blur_sigma > 0.0 {
            img = blur(&img, self.blur_sigma);
        }
        if self.resample < 0.999 {
            img = resample_roundtrip(&img, self.resample);
        }
        if self.chroma_420 {
            chroma_subsample(&mut img);
        }
        if self.jpeg > 0.0 {
            apply_blockiness(&mut img, self.jpeg);
        }
        if self.noise > 0.0 {
            add_noise(&mut img, self.noise, self.seed);
        }
        img
    }
}

struct Rng(u32);
impl Rng {
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }
    /// Irwin-Hall approximation of a normal, good enough for sensor noise.
    fn normal(&mut self) -> f32 {
        (self.unit() + self.unit() + self.unit() + self.unit() - 2.0) * 1.732
    }
}

#[inline]
fn clamp8(v: f32) -> u8 {
    v.clamp(0.0, 255.0) as u8
}

fn apply_response(img: &mut RgbImage, gain: [f32; 3], gamma: f32) {
    for i in 0..img.data.len() {
        let c = i % 3;
        let v = img.data[i] as f32 / 255.0;
        img.data[i] = clamp8(v.powf(gamma) * gain[c] * 255.0);
    }
}

fn apply_vignette(img: &mut RgbImage, strength: f32) {
    let (cx, cy) = (img.w as f32 / 2.0, img.h as f32 / 2.0);
    let max_r = (cx * cx + cy * cy).sqrt();
    for y in 0..img.h {
        for x in 0..img.w {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let r = (dx * dx + dy * dy).sqrt() / max_r;
            let f = 1.0 - strength * r * r;
            let i = (y * img.w + x) * 3;
            for v in img.data[i..i + 3].iter_mut() {
                *v = clamp8(*v as f32 * f);
            }
        }
    }
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as isize;
    let mut k: Vec<f32> = (-radius..=radius)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = k.iter().sum();
    for v in k.iter_mut() {
        *v /= sum;
    }
    k
}

fn blur(src: &RgbImage, sigma: f32) -> RgbImage {
    let k = gaussian_kernel(sigma);
    let radius = (k.len() / 2) as isize;
    let mut tmp = RgbImage::new(src.w, src.h);
    let mut out = RgbImage::new(src.w, src.h);

    for y in 0..src.h {
        for x in 0..src.w {
            let mut acc = [0f32; 3];
            for (j, kv) in k.iter().enumerate() {
                let sx = (x as isize + j as isize - radius).clamp(0, src.w as isize - 1) as usize;
                let p = src.px(sx, y);
                for c in 0..3 {
                    acc[c] += p[c] as f32 * kv;
                }
            }
            tmp.set(x, y, [clamp8(acc[0]), clamp8(acc[1]), clamp8(acc[2])]);
        }
    }
    for y in 0..src.h {
        for x in 0..src.w {
            let mut acc = [0f32; 3];
            for (j, kv) in k.iter().enumerate() {
                let sy = (y as isize + j as isize - radius).clamp(0, src.h as isize - 1) as usize;
                let p = tmp.px(x, sy);
                for c in 0..3 {
                    acc[c] += p[c] as f32 * kv;
                }
            }
            out.set(x, y, [clamp8(acc[0]), clamp8(acc[1]), clamp8(acc[2])]);
        }
    }
    out
}

/// Downsample to the sensor's real resolution, then back up — the detail lost in
/// between is exactly what a low-res camera throws away.
fn resample_roundtrip(src: &RgbImage, factor: f32) -> RgbImage {
    let sw = ((src.w as f32 * factor) as usize).max(2);
    let sh = ((src.h as f32 * factor) as usize).max(2);
    let mut small = RgbImage::new(sw, sh);
    for y in 0..sh {
        for x in 0..sw {
            let x0 = x * src.w / sw;
            let y0 = y * src.h / sh;
            let x1 = (((x + 1) * src.w) / sw).max(x0 + 1).min(src.w);
            let y1 = (((y + 1) * src.h) / sh).max(y0 + 1).min(src.h);
            let m = src.mean_rect(x0, y0, x1 - x0, y1 - y0);
            small.set(x, y, [clamp8(m[0]), clamp8(m[1]), clamp8(m[2])]);
        }
    }
    let mut out = RgbImage::new(src.w, src.h);
    for y in 0..src.h {
        for x in 0..src.w {
            let fx = (x as f32 + 0.5) * sw as f32 / src.w as f32 - 0.5;
            let fy = (y as f32 + 0.5) * sh as f32 / src.h as f32 - 0.5;
            let x0 = fx.floor().max(0.0) as usize;
            let y0 = fy.floor().max(0.0) as usize;
            let x1 = (x0 + 1).min(sw - 1);
            let y1 = (y0 + 1).min(sh - 1);
            let tx = (fx - x0 as f32).clamp(0.0, 1.0);
            let ty = (fy - y0 as f32).clamp(0.0, 1.0);
            let (a, b, c, d) = (
                small.px(x0, y0),
                small.px(x1, y0),
                small.px(x0, y1),
                small.px(x1, y1),
            );
            let mut px = [0u8; 3];
            for (k, out_px) in px.iter_mut().enumerate() {
                let top = a[k] as f32 * (1.0 - tx) + b[k] as f32 * tx;
                let bot = c[k] as f32 * (1.0 - tx) + d[k] as f32 * tx;
                *out_px = clamp8(top * (1.0 - ty) + bot * ty);
            }
            out.set(x, y, px);
        }
    }
    out
}

/// YUV 4:2:0 — the single most important degradation for a colour design.
/// Luma stays full resolution; chroma is box-averaged 2x2 and replicated back.
fn chroma_subsample(img: &mut RgbImage) {
    let (w, h) = (img.w, img.h);
    let mut y_p = vec![0f32; w * h];
    let mut cb = vec![0f32; w * h];
    let mut cr = vec![0f32; w * h];
    for i in 0..w * h {
        let (r, g, b) = (
            img.data[i * 3] as f32,
            img.data[i * 3 + 1] as f32,
            img.data[i * 3 + 2] as f32,
        );
        y_p[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    for by in (0..h).step_by(2) {
        for bx in (0..w).step_by(2) {
            let (mut sb, mut sr, mut n) = (0f32, 0f32, 0f32);
            for y in by..(by + 2).min(h) {
                for x in bx..(bx + 2).min(w) {
                    sb += cb[y * w + x];
                    sr += cr[y * w + x];
                    n += 1.0;
                }
            }
            let (mb, mr) = (sb / n, sr / n);
            for y in by..(by + 2).min(h) {
                for x in bx..(bx + 2).min(w) {
                    cb[y * w + x] = mb;
                    cr[y * w + x] = mr;
                }
            }
        }
    }
    for i in 0..w * h {
        let (yv, u, v) = (y_p[i], cb[i], cr[i]);
        img.data[i * 3] = clamp8(yv + 1.402 * v);
        img.data[i * 3 + 1] = clamp8(yv - 0.344136 * u - 0.714136 * v);
        img.data[i * 3 + 2] = clamp8(yv + 1.772 * u);
    }
}

fn apply_blockiness(img: &mut RgbImage, amount: f32) {
    let (w, h) = (img.w, img.h);
    for by in (0..h).step_by(8) {
        for bx in (0..w).step_by(8) {
            let bw = (bx + 8).min(w) - bx;
            let bh = (by + 8).min(h) - by;
            let m = img.mean_rect(bx, by, bw, bh);
            for y in by..by + bh {
                for x in bx..bx + bw {
                    let i = (y * w + x) * 3;
                    for (k, v) in img.data[i..i + 3].iter_mut().enumerate() {
                        *v = clamp8(*v as f32 * (1.0 - amount) + m[k] * amount);
                    }
                }
            }
        }
    }
}

fn add_noise(img: &mut RgbImage, sigma: f32, seed: u32) {
    let mut rng = Rng(seed | 1);
    for v in img.data.iter_mut() {
        *v = clamp8(*v as f32 + rng.normal() * sigma);
    }
}
