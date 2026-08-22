//! Geometry: corner fiducials, detection, homography, rectification.
//!
//! The pipeline this module completes is
//!
//! ```text
//! modem::render -> geometry::stamp_fiducials -> sim::Channel::apply
//!               -> geometry::rectify -> modem::sample
//! ```
//!
//! `rectify` returns an image in *canonical* frame geometry, so `modem::sample`
//! (and therefore every S0/S1 result) works unchanged on a hand-held capture.
//! Nothing here touches the frame layout or the sampling code.
//!
//! ## Fiducial design (ADR-0002 "four corner fiducials", ADR-0003 luma)
//!
//! Each marker is a bullseye of concentric squares, 6 units on a side:
//!
//! ```text
//! +---------------+  outer black ring   (1 unit thick)
//! | +-----------+ |  white ring         (1 unit thick)
//! | | +-------+ | |  black centre dot   (2 units)
//! | | |       | | |
//! | | +-------+ | |  ...surrounded by a white quiet zone that fills the rest
//! | +-----------+ |     of the corner margin.
//! +---------------+
//! ```
//!
//! Why this shape:
//! * **Pure black/white.** ADR-0003 makes luma the reliable channel and chroma
//!   half-resolution (4:2:0). A marker built from the two extreme luma levels
//!   (0.00 and 1.00) has 3.3x the luma separation of the closest pair of P8
//!   payload colours and needs no chroma at all.
//! * **Ring, not a solid blob.** A solid square is indistinguishable from a run
//!   of black payload cells. The nested black/white/black signature is verified
//!   by 17 probes and does not occur by accident in payload.
//! * **Centroid of the ring is the centre.** Centroids are affine-covariant, so
//!   rotation, scale and translation leave the estimate exact, and only the
//!   (small) perspective term biases it. Sub-pixel by construction, and it
//!   degrades gracefully under blur because blur is symmetric.
//! * **Larger than a payload cell** (>= 48 px, or 6 cells, whichever is bigger)
//!   so it survives the resample + blur that destroys individual cells.

use crate::frame::FrameSpec;
use crate::image::RgbImage;
use crate::palette::{BLACK, WHITE};

/// The marker is 6 units on a side.
pub const MARKER_UNITS: f64 = 6.0;
/// Smallest marker we will draw, in canonical pixels.
pub const MARKER_MIN_PX: usize = 72;
/// Largest marker we will draw, in canonical pixels.
pub const MARKER_MAX_PX: usize = 96;

/// Marker side in canonical pixels: eight payload cells, floored at 72 px so
/// each ring is still several sensor pixels thick after a potato camera's
/// 0.42 resample, and capped at 96 px so big-cell layers do not spend half the
/// frame on markers.
pub fn marker_size(cell: usize) -> usize {
    (8 * cell).clamp(MARKER_MIN_PX, MARKER_MAX_PX)
}

/// White separation between the marker and anything else. One marker unit, so
/// the outermost bullseye probe (at 7/6 of the half-width) lands in the middle
/// of the quiet band rather than on the first payload cell.
pub fn quiet_zone(cell: usize) -> usize {
    marker_size(cell) / 6
}

/// Frame margin required to hold a marker plus its quiet zone on both sides.
pub fn margin_for(cell: usize) -> usize {
    marker_size(cell) + 2 * quiet_zone(cell)
}

/// A [`FrameSpec`] with a margin wide enough for fiducials. This is the only
/// supported way to build a spec for the geometry pipeline; the wider margin
/// costs payload area, which is the price of being able to find the grid.
pub fn frame_spec(width: usize, height: usize, cell: usize) -> FrameSpec {
    FrameSpec {
        width,
        height,
        cell,
        margin: margin_for(cell),
    }
}

/// Marker side and the four top-left origins, in canonical pixels,
/// ordered TL, TR, BR, BL. `None` if the spec's margin is too small.
fn marker_layout(spec: &FrameSpec) -> Option<(f64, [[f64; 2]; 4])> {
    let q = quiet_zone(spec.cell);
    let m = spec.margin.checked_sub(2 * q)?;
    if m < 24 || spec.width < 4 * spec.margin || spec.height < 4 * spec.margin {
        return None;
    }
    let (mf, qf) = (m as f64, q as f64);
    let far_x = spec.width as f64 - qf - mf;
    let far_y = spec.height as f64 - qf - mf;
    Some((mf, [[qf, qf], [far_x, qf], [far_x, far_y], [qf, far_y]]))
}

/// Canonical centres of the four fiducials, ordered TL, TR, BR, BL.
pub fn marker_centers(spec: &FrameSpec) -> Option<[[f64; 2]; 4]> {
    let (m, origins) = marker_layout(spec)?;
    let h = m / 2.0;
    Some(origins.map(|o| [o[0] + h, o[1] + h]))
}

fn fill(img: &mut RgbImage, x: f64, y: f64, w: f64, h: f64, c: [u8; 3]) {
    let x0 = x.round().max(0.0) as usize;
    let y0 = y.round().max(0.0) as usize;
    let x1 = (x + w).round().max(0.0) as usize;
    let y1 = (y + h).round().max(0.0) as usize;
    img.fill_rect(x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0), c);
}

/// Draw the four corner fiducials into an already-rendered frame.
///
/// Only the margin is written; no payload cell is touched, so capacity is
/// unaffected by stamping (it is affected by the wider margin — see
/// [`frame_spec`]). Returns `false` if the spec has no room for markers.
pub fn stamp_fiducials(img: &mut RgbImage, spec: &FrameSpec) -> bool {
    let Some((m, origins)) = marker_layout(spec) else {
        return false;
    };
    let q = quiet_zone(spec.cell) as f64;
    let u = m / MARKER_UNITS;
    for o in origins {
        // Quiet zone: white, filling the corner block out to the payload edge.
        fill(img, o[0] - q, o[1] - q, m + 2.0 * q, m + 2.0 * q, WHITE);
        // Bullseye: black ring, white ring, black centre dot.
        fill(img, o[0], o[1], m, m, BLACK);
        fill(img, o[0] + u, o[1] + u, 4.0 * u, 4.0 * u, WHITE);
        fill(img, o[0] + 2.0 * u, o[1] + 2.0 * u, 2.0 * u, 2.0 * u, BLACK);
    }
    true
}

// ---------------------------------------------------------------------------
// 3x3 matrices / homography
// ---------------------------------------------------------------------------

pub type Mat3 = [[f64; 3]; 3];

pub fn mat3_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0f64; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

/// A plane-to-plane projective map.
#[derive(Clone, Copy, Debug)]
pub struct Homography {
    pub m: Mat3,
}

impl Homography {
    pub fn identity() -> Self {
        Self {
            m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        }
    }

    pub fn from_mat(m: Mat3) -> Self {
        Self { m }
    }

    /// Direct linear transform from four correspondences, `src[i] -> dst[i]`.
    /// Solves the 8x8 system by Gaussian elimination with partial pivoting —
    /// no external linear-algebra dependency (none is permitted).
    pub fn from_points(src: &[[f64; 2]; 4], dst: &[[f64; 2]; 4]) -> Option<Self> {
        let mut a = [[0f64; 9]; 8]; // augmented 8x8 | b
        for i in 0..4 {
            let (x, y) = (src[i][0], src[i][1]);
            let (u, v) = (dst[i][0], dst[i][1]);
            a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
            a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
        }
        let h = solve8(&mut a)?;
        Some(Self {
            m: [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]],
        })
    }

    pub fn apply(&self, p: [f64; 2]) -> [f64; 2] {
        let m = &self.m;
        let w = m[2][0] * p[0] + m[2][1] * p[1] + m[2][2];
        let w = if w.abs() < 1e-12 { 1e-12 } else { w };
        [
            (m[0][0] * p[0] + m[0][1] * p[1] + m[0][2]) / w,
            (m[1][0] * p[0] + m[1][1] * p[1] + m[1][2]) / w,
        ]
    }

    pub fn inverse(&self) -> Option<Self> {
        let m = &self.m;
        let c = [
            [
                m[1][1] * m[2][2] - m[1][2] * m[2][1],
                m[0][2] * m[2][1] - m[0][1] * m[2][2],
                m[0][1] * m[1][2] - m[0][2] * m[1][1],
            ],
            [
                m[1][2] * m[2][0] - m[1][0] * m[2][2],
                m[0][0] * m[2][2] - m[0][2] * m[2][0],
                m[0][2] * m[1][0] - m[0][0] * m[1][2],
            ],
            [
                m[1][0] * m[2][1] - m[1][1] * m[2][0],
                m[0][1] * m[2][0] - m[0][0] * m[2][1],
                m[0][0] * m[1][1] - m[0][1] * m[1][0],
            ],
        ];
        let det = m[0][0] * c[0][0] + m[0][1] * c[1][0] + m[0][2] * c[2][0];
        if det.abs() < 1e-12 {
            return None;
        }
        let mut out = [[0f64; 3]; 3];
        for (i, row) in out.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v = c[i][j] / det;
            }
        }
        Some(Self { m: out })
    }
}

fn solve8(a: &mut [[f64; 9]; 8]) -> Option<[f64; 8]> {
    for col in 0..8 {
        let mut piv = col;
        for r in col + 1..8 {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        let d = a[col][col];
        for v in a[col][col..].iter_mut() {
            *v /= d;
        }
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = a[r][col];
            if f == 0.0 {
                continue;
            }
            let pivot_row = a[col];
            for (v, pv) in a[r].iter_mut().zip(pivot_row.iter()).skip(col) {
                *v -= f * pv;
            }
        }
    }
    let mut out = [0f64; 8];
    for (i, v) in out.iter_mut().enumerate() {
        *v = a[i][8];
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Radial (barrel / pincushion) distortion
// ---------------------------------------------------------------------------

/// Single-parameter radial lens model about the image centre.
/// `k > 0` is pincushion, `k < 0` is barrel — the usual webcam sign.
#[derive(Clone, Copy, Debug)]
pub struct Radial {
    pub k: f64,
    pub cx: f64,
    pub cy: f64,
    pub norm: f64,
}

impl Radial {
    pub fn new(w: usize, h: usize, k: f64) -> Self {
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        Self {
            k,
            cx,
            cy,
            norm: (cx * cx + cy * cy).sqrt().max(1.0),
        }
    }

    /// Ideal pinhole point -> observed (lens-distorted) point.
    pub fn distort(&self, p: [f64; 2]) -> [f64; 2] {
        if self.k == 0.0 {
            return p;
        }
        let (dx, dy) = (p[0] - self.cx, p[1] - self.cy);
        let r2 = (dx * dx + dy * dy) / (self.norm * self.norm);
        let f = 1.0 + self.k * r2;
        [self.cx + dx * f, self.cy + dy * f]
    }

    /// Observed -> ideal. Newton inversion of `u + k u^3 = rd`, which converges
    /// quadratically; six steps are exact to well under a thousandth of a pixel
    /// across the whole valid range of `k`.
    pub fn undistort(&self, p: [f64; 2]) -> [f64; 2] {
        if self.k == 0.0 {
            return p;
        }
        let (dx, dy) = (p[0] - self.cx, p[1] - self.cy);
        let rd = (dx * dx + dy * dy).sqrt() / self.norm;
        if rd < 1e-12 {
            return p;
        }
        let mut u = rd;
        for _ in 0..6 {
            let g = u + self.k * u * u * u - rd;
            let dg = 1.0 + 3.0 * self.k * u * u;
            if dg.abs() < 1e-12 {
                break;
            }
            u -= g / dg;
        }
        let f = 1.0 + self.k * u * u;
        [self.cx + dx / f, self.cy + dy / f]
    }
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

/// Bilinear RGB fetch in *pixel-centre* coordinates. Out of bounds clamps.
pub fn bilinear(img: &RgbImage, x: f64, y: f64) -> [u8; 3] {
    let fx = (x - 0.5).clamp(0.0, img.w as f64 - 1.0);
    let fy = (y - 0.5).clamp(0.0, img.h as f64 - 1.0);
    let x0 = fx.floor() as usize;
    let y0 = fy.floor() as usize;
    let x1 = (x0 + 1).min(img.w - 1);
    let y1 = (y0 + 1).min(img.h - 1);
    let tx = fx - x0 as f64;
    let ty = fy - y0 as f64;
    let (a, b, c, d) = (
        img.px(x0, y0),
        img.px(x1, y0),
        img.px(x0, y1),
        img.px(x1, y1),
    );
    let mut out = [0u8; 3];
    for (k, o) in out.iter_mut().enumerate() {
        let top = a[k] as f64 * (1.0 - tx) + b[k] as f64 * tx;
        let bot = c[k] as f64 * (1.0 - tx) + d[k] as f64 * tx;
        *o = (top * (1.0 - ty) + bot * ty).clamp(0.0, 255.0) as u8;
    }
    out
}

fn luma_plane(img: &RgbImage) -> Vec<f32> {
    (0..img.w * img.h)
        .map(|i| {
            let d = &img.data[i * 3..i * 3 + 3];
            0.299 * d[0] as f32 + 0.587 * d[1] as f32 + 0.114 * d[2] as f32
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Fiducial detection
// ---------------------------------------------------------------------------

struct Blob {
    area: u32,
    sx: f64,
    sy: f64,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

/// Locally adaptive black mask: a pixel is black when it sits `bias` below the
/// mean of a large box around it. The box is computed from an integral image,
/// so vignette and gain drift (which are low-frequency) cancel out entirely.
fn adaptive_black_mask(luma: &[f32], w: usize, h: usize, radius: usize, bias: f32) -> Vec<bool> {
    let mut integral = vec![0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0f64;
        for x in 0..w {
            row += luma[y * w + x] as f64;
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
    }
    let mut mask = vec![false; w * h];
    for y in 0..h {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius + 1).min(h);
        for x in 0..w {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius + 1).min(w);
            let s = integral[y1 * (w + 1) + x1]
                - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0]
                + integral[y0 * (w + 1) + x0];
            let n = ((x1 - x0) * (y1 - y0)) as f64;
            let mean = (s / n) as f32;
            mask[y * w + x] = luma[y * w + x] < mean - bias;
        }
    }
    mask
}

fn label_blobs(mask: &[bool], w: usize, h: usize) -> Vec<Blob> {
    let mut seen = vec![false; w * h];
    let mut blobs = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if !mask[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let mut b = Blob {
            area: 0,
            sx: 0.0,
            sy: 0.0,
            x0: usize::MAX,
            y0: usize::MAX,
            x1: 0,
            y1: 0,
        };
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            b.area += 1;
            b.sx += x as f64;
            b.sy += y as f64;
            b.x0 = b.x0.min(x);
            b.y0 = b.y0.min(y);
            b.x1 = b.x1.max(x);
            b.y1 = b.y1.max(y);
            if x > 0 && mask[i - 1] && !seen[i - 1] {
                seen[i - 1] = true;
                stack.push(i - 1);
            }
            if x + 1 < w && mask[i + 1] && !seen[i + 1] {
                seen[i + 1] = true;
                stack.push(i + 1);
            }
            if y > 0 && mask[i - w] && !seen[i - w] {
                seen[i - w] = true;
                stack.push(i - w);
            }
            if y + 1 < h && mask[i + w] && !seen[i + w] {
                seen[i + w] = true;
                stack.push(i + w);
            }
        }
        blobs.push(b);
    }
    blobs
}

/// The bullseye signature, probed along the two axes from the blob centre.
/// Radii are fractions of the half-width: the centre dot spans 0..1/3, the
/// white ring 1/3..2/3, the black ring 2/3..1, and the quiet zone beyond 1.
const PROBES: [(f64, bool); 4] = [
    (0.167, true),  // centre dot: black
    (0.500, false), // white ring
    (0.833, true),  // black ring
    (1.167, false), // quiet zone
];

fn verify_bullseye(mask: &[bool], luma: &[f32], w: usize, h: usize, b: &Blob) -> f64 {
    let cx = (b.x0 + b.x1) as f64 / 2.0;
    let cy = (b.y0 + b.y1) as f64 / 2.0;
    let hx = (b.x1 - b.x0) as f64 / 2.0;
    let hy = (b.y1 - b.y0) as f64 / 2.0;
    let mut hit = 0.0;
    let mut total = 0.0;
    let mut dark = (0.0f64, 0.0f64);
    let mut light = (0.0f64, 0.0f64);
    let mut probe = |x: f64, y: f64, want: bool| {
        if x < 0.0 || y < 0.0 || x >= w as f64 || y >= h as f64 {
            return;
        }
        let i = y as usize * w + x as usize;
        total += 1.0;
        if mask[i] == want {
            hit += 1.0;
        }
        let acc = if want { &mut dark } else { &mut light };
        acc.0 += luma[i] as f64;
        acc.1 += 1.0;
    };
    probe(cx, cy, true);
    for (r, want) in PROBES {
        probe(cx + r * hx, cy, want);
        probe(cx - r * hx, cy, want);
        probe(cx, cy + r * hy, want);
        probe(cx, cy - r * hy, want);
    }
    if total < 9.0 || dark.1 == 0.0 || light.1 == 0.0 {
        return 0.0;
    }
    // The bullseye is built from the two extreme luma levels (ADR-0003). If the
    // rings are not separated in brightness this is payload, not a marker.
    if light.0 / light.1 - dark.0 / dark.1 < 30.0 {
        return 0.0;
    }
    hit / total
}

/// Minimum fraction of bullseye probes that must agree.
const VERIFY_THRESHOLD: f64 = 0.78;

/// A blob that passed the bullseye test.
#[derive(Clone, Copy, Debug)]
pub struct Candidate {
    /// Sub-pixel centre, in image pixel coordinates.
    pub center: [f64; 2],
    /// Fraction of bullseye probes that agreed, 0..1.
    pub score: f64,
    /// Observed marker side, in image pixels.
    pub size: f64,
}

/// Every bullseye-shaped blob in the image. Exposed so tests (and humans) can
/// see what detection saw, not just what it concluded.
pub fn fiducial_candidates(img: &RgbImage, spec: &FrameSpec) -> Vec<Candidate> {
    let Some((marker, _)) = marker_layout(spec) else {
        return Vec::new();
    };
    let (w, h) = (img.w, img.h);
    if w < 32 || h < 32 {
        return Vec::new();
    }
    let luma = luma_plane(img);
    // The window must be small enough that it does not drown in the dark frame
    // border: one marker-third spans the black ring and the white either side.
    let radius = (marker as usize / 3).clamp(8, w.min(h) / 4);
    let mask = adaptive_black_mask(&luma, w, h, radius, 8.0);
    let blobs = label_blobs(&mask, w, h);

    let max_side = (w.min(h) / 4) as f64;
    let mut out = Vec::new();
    for b in &blobs {
        let bw = (b.x1 - b.x0 + 1) as f64;
        let bh = (b.y1 - b.y0 + 1) as f64;
        if b.area < 32 || bw < 10.0 || bh < 10.0 || bw > max_side || bh > max_side {
            continue;
        }
        let aspect = bw / bh;
        if !(0.5..=2.0).contains(&aspect) {
            continue;
        }
        // A ring fills ~5/9 of its bounding box; a solid blob fills ~1.
        let fill = b.area as f64 / (bw * bh);
        if !(0.20..=0.85).contains(&fill) {
            continue;
        }
        let score = verify_bullseye(&mask, &luma, w, h, b);
        if score < VERIFY_THRESHOLD {
            continue;
        }
        out.push(Candidate {
            // +0.5: blob statistics are in pixel-index space, geometry is in
            // pixel-centre space.
            center: [b.sx / b.area as f64 + 0.5, b.sy / b.area as f64 + 0.5],
            score,
            size: (bw + bh) / 2.0,
        });
    }
    out
}

/// Locate the four fiducials in a captured frame. Returns their centres in
/// image pixels, ordered TL, TR, BR, BL to match [`marker_centers`].
///
/// Corner roles are assigned by the extremes of `x+y` and `x-y`, which is
/// unambiguous up to +-45 degrees of in-plane rotation. Beyond that the frame
/// would need an asymmetric marker to break the four-fold ambiguity; ADR-0002
/// leaves that for when a use case demands it.
pub fn detect_fiducials(img: &RgbImage, spec: &FrameSpec) -> Option<[[f64; 2]; 4]> {
    let cands = fiducial_candidates(img, spec);
    if cands.len() < 4 {
        return None;
    }
    // Payload can throw up the odd ring-shaped blob, but every such blob lies
    // *inside* the quadrilateral the four markers span — the markers sit in the
    // frame margin, outside all payload. So taking the extremes of x+y and x-y
    // is immune to payload false positives, as long as all four real markers
    // were found. The convexity and area checks below are what catch the case
    // where one was not.
    let pick = |f: &dyn Fn(&Candidate) -> f64| -> usize {
        let mut best = 0usize;
        for (i, c) in cands.iter().enumerate() {
            if f(c) < f(&cands[best]) {
                best = i;
            }
        }
        best
    };
    let idx = [
        pick(&|c| c.center[0] + c.center[1]),
        pick(&|c| -(c.center[0] - c.center[1])),
        pick(&|c| -(c.center[0] + c.center[1])),
        pick(&|c| c.center[0] - c.center[1]),
    ];
    for i in 0..4 {
        for j in i + 1..4 {
            if idx[i] == idx[j] {
                return None;
            }
        }
    }
    let quad = idx.map(|i| cands[i].center);

    // A real capture of a rectangle is a convex quad traversed in one
    // direction, covering a decent part of the sensor. Anything else means we
    // mis-paired the corners.
    let cross = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    let signs: Vec<f64> = (0..4)
        .map(|i| cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]).signum())
        .collect();
    if signs.iter().any(|s| *s != signs[0]) {
        return None;
    }
    let area = 0.5
        * ((0..4)
            .map(|i| {
                let (a, b) = (quad[i], quad[(i + 1) % 4]);
                a[0] * b[1] - b[0] * a[1]
            })
            .sum::<f64>())
        .abs();
    if area < 0.04 * (img.w * img.h) as f64 {
        return None;
    }
    Some(quad)
}

// ---------------------------------------------------------------------------
// Rectification
// ---------------------------------------------------------------------------

/// Canonical -> image map: homography followed by lens distortion.
#[derive(Clone, Copy, Debug)]
pub struct GeometryFit {
    pub h: Homography,
    pub radial: Radial,
}

impl GeometryFit {
    pub fn map(&self, p: [f64; 2]) -> [f64; 2] {
        self.radial.distort(self.h.apply(p))
    }
}

pub fn fit_for(
    img: &RgbImage,
    spec: &FrameSpec,
    obs: &[[f64; 2]; 4],
    k: f64,
) -> Option<GeometryFit> {
    let canon = marker_centers(spec)?;
    let radial = Radial::new(img.w, img.h, k);
    let undist = obs.map(|p| radial.undistort(p));
    let h = Homography::from_points(&canon, &undist)?;
    Some(GeometryFit { h, radial })
}

/// Taps inside one cell, as fractions of the cell pitch.
const TAPS: [f64; 3] = [0.3, 0.5, 0.7];

/// How well a candidate geometry explains the cell grid: the ratio of variance
/// *between* cells to variance *within* a cell (a Fisher ratio).
///
/// Four fiducials pin the homography exactly, so the lens term cannot be
/// recovered from them — but it can be read off the frame's own grid. When the
/// sampling lattice sits on cell centres, every tap inside a cell agrees
/// (within-variance -> 0) while different cells disagree (between-variance is
/// the palette spread). Straddle a cell boundary and both move the other way.
/// Unlike raw contrast this cannot be maximised by an accidentally sharp but
/// wrong alignment.
pub fn grid_score(img: &RgbImage, spec: &FrameSpec, fit: &GeometryFit) -> f64 {
    let step = 3usize;
    let cell = spec.cell as f64;
    let mut means: Vec<f64> = Vec::new();
    let mut within = 0.0f64;
    for r in (0..spec.rows()).step_by(step) {
        for c in (0..spec.cols()).step_by(step) {
            let (x0, y0) = spec.cell_origin(c, r);
            let mut taps = [0f64; 9];
            for (i, t) in taps.iter_mut().enumerate() {
                let p = fit.map([
                    x0 as f64 + TAPS[i % 3] * cell,
                    y0 as f64 + TAPS[i / 3] * cell,
                ]);
                if p[0] < 0.0 || p[1] < 0.0 || p[0] >= img.w as f64 || p[1] >= img.h as f64 {
                    return f64::NEG_INFINITY;
                }
                let px = bilinear(img, p[0], p[1]);
                *t = 0.299 * px[0] as f64 + 0.587 * px[1] as f64 + 0.114 * px[2] as f64;
            }
            let m = taps.iter().sum::<f64>() / 9.0;
            within += taps.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / 9.0;
            means.push(m);
        }
    }
    let n = means.len() as f64;
    if n < 16.0 {
        return f64::NEG_INFINITY;
    }
    let gm = means.iter().sum::<f64>() / n;
    let between = means.iter().map(|v| (v - gm) * (v - gm)).sum::<f64>() / n;
    between / (within / n + 1.0)
}

/// Largest lens term we will consider. Beyond |k| = 1/3 the radial polynomial
/// stops being monotone inside the image and the model folds the picture onto
/// itself — which produces a spurious, very high grid score. 0.20 keeps a wide
/// margin from that and still covers any real webcam.
pub const K_MAX: f64 = 0.20;

/// Coarse-to-fine search stages for the lens term: (half-span, step).
/// A 0.001 error in `k` moves the frame edge by about one pixel, so the last
/// stage has to be this fine.
const K_STAGES: [(f64, f64); 3] = [(K_MAX, 0.010), (0.012, 0.0012), (0.0015, 0.0002)];

/// Detect the fiducials and fit the full canonical -> image geometry,
/// including the one-parameter lens term.
pub fn fit_geometry(img: &RgbImage, spec: &FrameSpec) -> Option<GeometryFit> {
    let obs = detect_fiducials(img, spec)?;
    let mut centre = 0.0f64;
    let mut best: Option<GeometryFit> = None;
    for (span, step) in K_STAGES {
        let n = (2.0 * span / step).round() as i64;
        let mut stage: Option<(f64, f64, GeometryFit)> = None;
        for i in 0..=n {
            let k = (centre - span + step * i as f64).clamp(-K_MAX, K_MAX);
            let Some(fit) = fit_for(img, spec, &obs, k) else {
                continue;
            };
            let sc = grid_score(img, spec, &fit);
            if stage.as_ref().is_none_or(|(bs, ..)| sc > *bs) {
                stage = Some((sc, k, fit));
            }
        }
        let (_, k, fit) = stage?;
        centre = k;
        best = Some(fit);
    }
    best
}

/// Warp a distorted capture back to canonical frame geometry so that
/// [`crate::modem::sample`] works on it unchanged.
///
/// Returns `None` when the fiducials cannot be found — a loud failure, which
/// ADR-0011 requires ("cannot see the code"), never a silent wrong decode.
pub fn rectify(img: &RgbImage, spec: &FrameSpec) -> Option<RgbImage> {
    let fit = fit_geometry(img, spec)?;
    Some(warp_with(img, spec, &fit))
}

/// Inverse-warp with bilinear resampling under a known geometry.
pub fn warp_with(img: &RgbImage, spec: &FrameSpec, fit: &GeometryFit) -> RgbImage {
    let mut out = RgbImage::new(spec.width, spec.height);
    for y in 0..spec.height {
        for x in 0..spec.width {
            let p = fit.map([x as f64 + 0.5, y as f64 + 0.5]);
            out.set(x, y, bilinear(img, p[0], p[1]));
        }
    }
    out
}

/// RMS distance between two ordered point sets, in pixels.
pub fn rms_error(a: &[[f64; 2]; 4], b: &[[f64; 2]; 4]) -> f64 {
    let s: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(p, q)| (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2))
        .sum();
    (s / 4.0).sqrt()
}
