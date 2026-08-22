//! Symbols <-> pixels. The whole optical layer, and nothing else.

use crate::frame::FrameSpec;
use crate::image::RgbImage;
use crate::palette::Palette;

/// Render payload symbols into a frame. Symbols beyond capacity are ignored;
/// unused cells are padded with symbol 0.
pub fn render(payload: &[u8], spec: &FrameSpec, pal: &Palette) -> RgbImage {
    let mut img = RgbImage::new(spec.width, spec.height);
    let cols = spec.cols();

    // Calibration strip: every palette colour, cycling. The decoder recovers the
    // *measured* palette from this, which absorbs white-balance and gamma drift.
    for c in 0..cols {
        let sym = (c % pal.len()) as u8;
        let (x, y) = spec.cell_origin(c, 0);
        img.fill_rect(x, y, spec.cell, spec.cell, pal.color(sym));
    }

    for i in 0..spec.payload_cells() {
        let sym = payload.get(i).copied().unwrap_or(0);
        let c = i % cols;
        let r = FrameSpec::CALIB_ROWS + i / cols;
        let (x, y) = spec.cell_origin(c, r);
        img.fill_rect(x, y, spec.cell, spec.cell, pal.color(sym));
    }
    img
}

/// Recover the measured palette from the calibration strip: the mean observed
/// colour of every cell carrying each symbol.
pub fn measure_reference(img: &RgbImage, spec: &FrameSpec, pal: &Palette) -> Vec<[f32; 3]> {
    let mut sums = vec![[0f32; 3]; pal.len()];
    let mut counts = vec![0f32; pal.len()];
    for c in 0..spec.cols() {
        let sym = c % pal.len();
        let (x, y, w, h) = spec.sample_rect(c, 0);
        let m = img.mean_rect(x, y, w, h);
        for (dst, v) in sums[sym].iter_mut().zip(m.iter()) {
            *dst += v;
        }
        counts[sym] += 1.0;
    }
    let ideal = pal.ideal_reference();
    sums.iter()
        .zip(counts.iter())
        .enumerate()
        .map(|(i, (s, n))| {
            if *n == 0.0 {
                ideal[i]
            } else {
                [s[0] / n, s[1] / n, s[2] / n]
            }
        })
        .collect()
}

/// Read payload symbols back out of a frame.
pub fn sample(img: &RgbImage, spec: &FrameSpec, pal: &Palette) -> Vec<u8> {
    let reference = measure_reference(img, spec, pal);
    let cols = spec.cols();
    let mut out = Vec::with_capacity(spec.payload_cells());
    for i in 0..spec.payload_cells() {
        let c = i % cols;
        let r = FrameSpec::CALIB_ROWS + i / cols;
        let (x, y, w, h) = spec.sample_rect(c, r);
        out.push(pal.nearest(img.mean_rect(x, y, w, h), &reference));
    }
    out
}

/// Fraction of symbols that came back wrong.
pub fn symbol_error_rate(sent: &[u8], got: &[u8]) -> f64 {
    let n = sent.len().min(got.len());
    if n == 0 {
        return 1.0;
    }
    let bad = (0..n).filter(|&i| sent[i] != got[i]).count();
    bad as f64 / n as f64
}
