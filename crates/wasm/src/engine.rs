//! The whole optical stack, composed, with no wasm-bindgen anywhere in it.
//!
//! `optical-core` is deliberately a set of layers (ADR-0009) — chunking, fountain,
//! frame header, modem, geometry — and nobody in the repo had yet stacked them into
//! one object that turns bytes into an endless frame stream and back. That stacking
//! is this file. It is kept free of `wasm_bindgen` so the identical code path can be
//! compiled natively (`src/bin/bench_native.rs`) and timed against the wasm build:
//! that is the only honest way to price the boundary.
//!
//! Two things here are *not* in `optical-core` and had to be invented:
//!
//! * **Manifest transport.** `docs/contracts/wasm-api.md` says the receiver's
//!   `manifest()` is "null until the first header decodes", but the 25-byte frame
//!   header (`header.rs`) carries only magic/version/seq/payload_len/oti — there is
//!   nowhere to put a manifest. So the manifest is serialised (see [`encode_manifest`])
//!   and broadcast as a **pseudo-chunk** with `seq == MANIFEST_SEQ` (`u32::MAX`),
//!   fountain-coded exactly like a data chunk: burst first, then one frame in every
//!   [`MANIFEST_EVERY`]. `seq` is the chunk index for every other frame.
//!
//! * **RGBA sampling.** The camera hands us RGBA (`ImageData`), `optical-core`
//!   speaks RGB888. De-interleaving 8.3 MB per frame just to call `modem::sample`
//!   would put a copy back on the hot path that ADR-0007 says is not there, so the
//!   aligned path samples the RGBA buffer in place ([`sample_band_rgba`]). Only the
//!   geometry path (which must call `geometry::warp_with`, which builds an
//!   `RgbImage`) pays for the conversion.

use std::collections::{HashMap, VecDeque};

use optical_core::frame::FrameSpec;
use optical_core::geometry;
use optical_core::header::{self, FrameHeader};
use optical_core::image::RgbImage;
use optical_core::palette::{Palette, P2, P4, P8};
use optical_core::pipeline::{
    self, ByteSource, ChunkMeta, Config, Encoder, Encoding, Manifest, ResumeCode,
};
use optical_core::{codec, fountain, modem};

/// The `seq` value that marks a frame as carrying the manifest rather than a chunk.
pub const MANIFEST_SEQ: u32 = u32::MAX;
/// After the opening burst, one frame in this many re-broadcasts the manifest, so a
/// receiver that joins late still learns the transfer without a back-channel (ADR-0005).
pub const MANIFEST_EVERY: u64 = 24;
/// Frames spent on a chunk before moving on: K plus 25% plus a floor. There is no
/// back-channel, so this is an open-loop guess; the fountain makes an over- or
/// under-shoot cost time, never correctness (ADR-0004).
fn budget_for(k: usize) -> u64 {
    (k + k / 4 + 4) as u64
}

// ---------------------------------------------------------------------------
// profiles (ADR-0011, numbers from artifacts/s4-frontier.csv)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    L0,
    L1,
    L2,
    L3,
    L4,
}

impl Profile {
    /// `"auto"` resolves to L3 = P8 @ 8 px, the S4 frontier for both `good+warp`
    /// and `webcam+warp` (SER 0, 8,748 B/frame).
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "auto" | "AUTO" | "L3" => Profile::L3,
            "L0" => Profile::L0,
            "L1" => Profile::L1,
            "L2" => Profile::L2,
            "L4" => Profile::L4,
            _ => return None,
        })
    }

    pub fn cell(self) -> usize {
        match self {
            Profile::L0 => 20,
            Profile::L1 => 14,
            Profile::L2 => 10,
            Profile::L3 => 8,
            Profile::L4 => 6,
        }
    }

    /// Every rung is P8 after S4: the measured potato still reads P8 @ 20 px
    /// (ADR-0011 "Revised after S4"), so dropping to P4/P2 buys nothing.
    pub fn palette(self) -> &'static Palette {
        match self {
            Profile::L0 => &P8,
            Profile::L1 => &P8,
            Profile::L2 => &P8,
            Profile::L3 => &P8,
            Profile::L4 => &P8,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Profile::L0 => "L0",
            Profile::L1 => "L1",
            Profile::L2 => "L2",
            Profile::L3 => "L3",
            Profile::L4 => "L4",
        }
    }
}

/// Palettes tried when a profile string names one explicitly (test hook).
pub fn palette_by_name(s: &str) -> Option<&'static Palette> {
    match s {
        "P2" => Some(&P2),
        "P4" => Some(&P4),
        "P8" => Some(&P8),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// manifest serialisation
// ---------------------------------------------------------------------------

const MANIFEST_MAGIC: u32 = 0x5451_4D46; // "TQMF"
const MANIFEST_FIXED: usize = 4 + 8 + 4 + 4 + 1 + 32;
const MANIFEST_PER_CHUNK: usize = 4 + 4 + 32;

pub fn encode_manifest(m: &Manifest) -> Vec<u8> {
    let mut v = Vec::with_capacity(MANIFEST_FIXED + m.chunks.len() * MANIFEST_PER_CHUNK);
    v.extend_from_slice(&MANIFEST_MAGIC.to_be_bytes());
    v.extend_from_slice(&m.total_size.to_be_bytes());
    v.extend_from_slice(&m.chunk_size.to_be_bytes());
    v.extend_from_slice(&m.chunk_count.to_be_bytes());
    v.push(match m.encoding {
        Encoding::Raw => 0,
        Encoding::Gzip => 1,
    });
    v.extend_from_slice(&m.file_hash);
    for c in &m.chunks {
        v.extend_from_slice(&c.plain_len.to_be_bytes());
        v.extend_from_slice(&c.stored_len.to_be_bytes());
        v.extend_from_slice(&c.hash);
    }
    v
}

pub fn decode_manifest(b: &[u8]) -> Option<Manifest> {
    if b.len() < MANIFEST_FIXED {
        return None;
    }
    if u32::from_be_bytes(b[0..4].try_into().ok()?) != MANIFEST_MAGIC {
        return None;
    }
    let total_size = u64::from_be_bytes(b[4..12].try_into().ok()?);
    let chunk_size = u32::from_be_bytes(b[12..16].try_into().ok()?);
    let chunk_count = u32::from_be_bytes(b[16..20].try_into().ok()?);
    let encoding = match b[20] {
        0 => Encoding::Raw,
        1 => Encoding::Gzip,
        _ => return None,
    };
    let mut file_hash = [0u8; 32];
    file_hash.copy_from_slice(&b[21..53]);
    let need = MANIFEST_FIXED + chunk_count as usize * MANIFEST_PER_CHUNK;
    if b.len() < need {
        return None;
    }
    let mut chunks = Vec::with_capacity(chunk_count as usize);
    for i in 0..chunk_count as usize {
        let o = MANIFEST_FIXED + i * MANIFEST_PER_CHUNK;
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&b[o + 8..o + 40]);
        chunks.push(ChunkMeta {
            index: i as u32,
            plain_len: u32::from_be_bytes(b[o..o + 4].try_into().ok()?),
            stored_len: u32::from_be_bytes(b[o + 4..o + 8].try_into().ok()?),
            hash,
        });
    }
    Some(Manifest {
        total_size,
        chunk_size,
        chunk_count,
        encoding,
        chunks,
        file_hash,
    })
}

// ---------------------------------------------------------------------------
// sender
// ---------------------------------------------------------------------------

struct Owned(Vec<u8>);

impl ByteSource for Owned {
    fn total_len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize {
        let start = (offset as usize).min(self.0.len());
        let n = buf.len().min(self.0.len() - start);
        buf[..n].copy_from_slice(&self.0[start..start + n]);
        n
    }
}

pub struct FrameRef {
    pub ptr: *const u8,
    pub len: usize,
    pub width: usize,
    pub height: usize,
}

pub struct Sender {
    enc: Encoder<Owned>,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    profile: Profile,
    spec: FrameSpec,
    pal: &'static Palette,

    manifest_tx: fountain::Transmitter,
    manifest_burst: u64,

    chunk: usize,
    chunk_tx: Option<fountain::Transmitter>,
    chunk_left: u64,

    frames: u64,
    /// The one RGBA buffer handed to JS, allocated once and rewritten in place.
    rgba: Vec<u8>,
    /// Reused RGB canvas. `header::encode_frame` would allocate a fresh 6.2 MB
    /// `RgbImage` on every frame; at 30 FPS that is 186 MB/s of churn through the
    /// wasm allocator for no reason, so the render is composed from the public
    /// `encode_symbols` + `modem::render_*` pieces into a canvas that lives as long
    /// as the sender does.
    img: RgbImage,
    stamp: bool,
    stamped: bool,
}

impl Sender {
    pub fn create(
        bytes: Vec<u8>,
        profile: Profile,
        chunk_size: usize,
        width: usize,
        height: usize,
    ) -> Option<Self> {
        if bytes.is_empty() || chunk_size == 0 || width < 64 || height < 64 {
            return None;
        }
        let spec = geometry::frame_spec(width, height, profile.cell());
        let pal = profile.palette();
        let capacity = spec.capacity_bytes(pal);
        if capacity <= fountain::PACKET_HEADER_BYTES || capacity > u16::MAX as usize {
            return None;
        }
        if header::header_copies(&spec, pal) == 0 {
            return None;
        }
        let enc = Encoder::build(Owned(bytes), Config::default().with_chunk_size(chunk_size));
        let manifest = enc.manifest().clone();
        let manifest_bytes = encode_manifest(&manifest);
        let manifest_tx = fountain::Transmitter::new(&manifest_bytes, capacity).ok()?;
        let burst = budget_for(manifest_tx.source_symbols());
        let mut s = Self {
            enc,
            manifest,
            manifest_bytes,
            profile,
            spec,
            pal,
            manifest_tx,
            manifest_burst: burst,
            chunk: 0,
            chunk_tx: None,
            chunk_left: 0,
            frames: 0,
            rgba: vec![0u8; width * height * 4],
            img: RgbImage::new(width, height),
            stamp: true,
            stamped: false,
        };
        s.arm_chunk(0)?;
        Some(s)
    }

    fn capacity(&self) -> usize {
        self.spec.capacity_bytes(self.pal)
    }

    fn arm_chunk(&mut self, index: usize) -> Option<()> {
        let n = self.manifest.chunk_count as usize;
        if n == 0 {
            return None;
        }
        let index = index % n;
        let payload = self.enc.chunk_payload(index).ok()?;
        let tx = fountain::Transmitter::new(&payload, self.capacity()).ok()?;
        self.chunk_left = budget_for(tx.source_symbols());
        self.chunk = index;
        self.chunk_tx = Some(tx);
        Some(())
    }

    pub fn set_profile(&mut self, p: Profile) -> bool {
        if p == self.profile {
            return true;
        }
        let spec = geometry::frame_spec(self.spec.width, self.spec.height, p.cell());
        let pal = p.palette();
        let cap = spec.capacity_bytes(pal);
        if cap <= fountain::PACKET_HEADER_BYTES
            || cap > u16::MAX as usize
            || header::header_copies(&spec, pal) == 0
        {
            return false;
        }
        self.profile = p;
        self.spec = spec;
        self.pal = pal;
        self.stamped = false;
        self.img.data.fill(0);
        // Capacity changed, so every fountain must be rebuilt at the new symbol size.
        let Ok(mtx) = fountain::Transmitter::new(&self.manifest_bytes, cap) else {
            return false;
        };
        self.manifest_burst = budget_for(mtx.source_symbols());
        self.manifest_tx = mtx;
        let c = self.chunk;
        self.arm_chunk(c).is_some()
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn profile(&self) -> Profile {
        self.profile
    }

    pub fn chunk_index(&self) -> usize {
        self.chunk
    }

    pub fn frames_emitted(&self) -> u64 {
        self.frames
    }

    pub fn set_stamp_fiducials(&mut self, on: bool) {
        self.stamp = on;
        self.stamped = false;
        self.img.data.fill(0);
    }

    /// The next frame of the endless broadcast, RGBA, in a buffer that is allocated
    /// once and rewritten in place. `None` only if the frame cannot be built at all.
    pub fn next_frame(&mut self) -> Option<FrameRef> {
        let manifest_frame =
            self.frames < self.manifest_burst || self.frames % MANIFEST_EVERY == MANIFEST_EVERY - 1;

        let (seq, packet) = if manifest_frame {
            (MANIFEST_SEQ, self.manifest_tx.next_packet())
        } else {
            if self.chunk_left == 0 {
                let next = self.chunk + 1;
                self.arm_chunk(next)?;
            }
            self.chunk_left -= 1;
            let tx = self.chunk_tx.as_mut()?;
            (self.chunk as u32, tx.next_packet())
        };
        let oti = if manifest_frame {
            self.manifest_tx.oti()
        } else {
            self.chunk_tx.as_ref()?.oti()
        };

        let h = FrameHeader::new(seq, packet.len() as u16, oti);
        let (hdr_syms, pay_syms) = header::encode_symbols(&h, &packet, &self.spec, self.pal)?;
        modem::render_calibration(&mut self.img, &self.spec, self.pal);
        modem::render_band(
            &mut self.img,
            &hdr_syms,
            &self.spec,
            self.pal,
            self.spec.header_row0(),
            self.spec.header_rows(),
        );
        modem::render_band(
            &mut self.img,
            &pay_syms,
            &self.spec,
            self.pal,
            self.spec.payload_row0(),
            self.spec.payload_rows(),
        );
        // The fiducials live in the margin, which no band ever writes, so they are
        // stamped once and survive every later frame untouched.
        if self.stamp && !self.stamped {
            geometry::stamp_fiducials(&mut self.img, &self.spec);
            self.stamped = true;
        }
        rgb_to_rgba(&self.img.data, &mut self.rgba);
        self.frames += 1;
        Some(FrameRef {
            ptr: self.rgba.as_ptr(),
            len: self.rgba.len(),
            width: self.spec.width,
            height: self.spec.height,
        })
    }
}

#[inline]
fn rgb_to_rgba(src: &[u8], dst: &mut [u8]) {
    let n = (src.len() / 3).min(dst.len() / 4);
    for i in 0..n {
        dst[i * 4] = src[i * 3];
        dst[i * 4 + 1] = src[i * 3 + 1];
        dst[i * 4 + 2] = src[i * 3 + 2];
        dst[i * 4 + 3] = 255;
    }
}

// ---------------------------------------------------------------------------
// RGBA sampling — the zero-copy hot path
// ---------------------------------------------------------------------------

#[inline]
fn mean_rect_rgba(
    buf: &[u8],
    w: usize,
    h: usize,
    x0: usize,
    y0: usize,
    rw: usize,
    rh: usize,
) -> [f32; 3] {
    let (mut r, mut g, mut b, mut n) = (0f32, 0f32, 0f32, 0f32);
    for y in y0..(y0 + rh).min(h) {
        let row = y * w * 4;
        for x in x0..(x0 + rw).min(w) {
            let i = row + x * 4;
            r += buf[i] as f32;
            g += buf[i + 1] as f32;
            b += buf[i + 2] as f32;
            n += 1.0;
        }
    }
    if n == 0.0 {
        return [0.0; 3];
    }
    [r / n, g / n, b / n]
}

#[inline]
fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

/// Recover the measured palette from the calibration strip, and score how cleanly
/// the strip separates: `quality` is `1 - d1/d2` averaged over the strip, i.e. how
/// far each observed colour sits from the *wrong* answer. 1.0 = pristine.
fn measure_reference_rgba(buf: &[u8], spec: &FrameSpec, pal: &Palette) -> (Vec<[f32; 3]>, f32) {
    let (w, h) = (spec.width, spec.height);
    let mut sums = vec![[0f32; 3]; pal.len()];
    let mut counts = vec![0f32; pal.len()];
    for c in 0..spec.cols() {
        let sym = c % pal.len();
        let (x, y, rw, rh) = spec.sample_rect(c, 0);
        let m = mean_rect_rgba(buf, w, h, x, y, rw, rh);
        for k in 0..3 {
            sums[sym][k] += m[k];
        }
        counts[sym] += 1.0;
    }
    let ideal = pal.ideal_reference();
    let reference: Vec<[f32; 3]> = sums
        .iter()
        .zip(counts.iter())
        .enumerate()
        .map(|(i, (s, n))| {
            if *n == 0.0 {
                ideal[i]
            } else {
                [s[0] / n, s[1] / n, s[2] / n]
            }
        })
        .collect();

    let mut acc = 0f32;
    let mut n = 0f32;
    for c in 0..spec.cols() {
        let (x, y, rw, rh) = spec.sample_rect(c, 0);
        let m = mean_rect_rgba(buf, w, h, x, y, rw, rh);
        let (mut d1, mut d2) = (f32::MAX, f32::MAX);
        for r in &reference {
            let d = dist2(m, *r);
            if d < d1 {
                d2 = d1;
                d1 = d;
            } else if d < d2 {
                d2 = d;
            }
        }
        if d2 > 0.0 && d2.is_finite() {
            acc += 1.0 - (d1 / d2).sqrt();
            n += 1.0;
        }
    }
    let quality = if n > 0.0 {
        (acc / n).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (reference, quality)
}

fn sample_band_rgba(
    buf: &[u8],
    spec: &FrameSpec,
    pal: &Palette,
    reference: &[[f32; 3]],
    row0: usize,
    rows: usize,
    out: &mut Vec<u8>,
) {
    let cols = spec.cols();
    out.clear();
    out.reserve(rows * cols);
    for i in 0..rows * cols {
        let (x, y, rw, rh) = spec.sample_rect(i % cols, row0 + i / cols);
        let m = mean_rect_rgba(buf, spec.width, spec.height, x, y, rw, rh);
        out.push(pal.nearest(m, reference));
    }
}

// ---------------------------------------------------------------------------
// receiver
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropReason {
    NoFiducials,
    BadCrc,
    Duplicate,
}

impl DropReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DropReason::NoFiducials => "no_fiducials",
            DropReason::BadCrc => "bad_crc",
            DropReason::Duplicate => "duplicate",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PushResult {
    pub accepted: bool,
    pub reason: Option<DropReason>,
    pub chunk_complete: Option<u32>,
    pub needed_more: u32,
    pub quality: f32,
    /// True when the frame only decoded after the geometry search ran.
    pub rectified: bool,
}

pub struct Receiver {
    spec: FrameSpec,
    pal: &'static Palette,
    profile: Profile,
    /// The camera's landing pad. JS writes straight into this — it is the buffer
    /// `frame_buffer()` hands out, and it is never reallocated.
    frame: Vec<u8>,
    rgb: RgbImage,
    hdr_syms: Vec<u8>,
    pay_syms: Vec<u8>,

    manifest: Option<Manifest>,
    manifest_fx: Option<fountain::Receiver>,
    chunk_fx: HashMap<u32, fountain::Receiver>,
    /// Chunks whose fountain finished before the manifest arrived.
    pending: HashMap<u32, Vec<u8>>,
    ready: VecDeque<(u32, Vec<u8>)>,
    take: Vec<u8>,
    done: Vec<bool>,
    quality: f32,
    geometry: bool,
    frames_seen: u64,
    frames_accepted: u64,
}

impl Receiver {
    pub fn create(profile: Profile, width: usize, height: usize) -> Option<Self> {
        if width < 64 || height < 64 {
            return None;
        }
        let spec = geometry::frame_spec(width, height, profile.cell());
        let pal = profile.palette();
        if header::header_copies(&spec, pal) == 0 {
            return None;
        }
        Some(Self {
            spec,
            pal,
            profile,
            frame: vec![0u8; width * height * 4],
            rgb: RgbImage::new(width, height),
            hdr_syms: Vec::new(),
            pay_syms: Vec::new(),
            manifest: None,
            manifest_fx: None,
            chunk_fx: HashMap::new(),
            pending: HashMap::new(),
            ready: VecDeque::new(),
            take: Vec::new(),
            done: Vec::new(),
            quality: 0.0,
            geometry: true,
            frames_seen: 0,
            frames_accepted: 0,
        })
    }

    /// Rebuild over a partially-written output. `have` is a bitmap, LSB-first.
    /// The manifest must be the exact bytes `Sender::manifest_bytes()` produced —
    /// the summary object of the contract has no per-chunk hashes, so it cannot
    /// support the per-chunk verification the resume section requires.
    pub fn resume(
        profile: Profile,
        width: usize,
        height: usize,
        code: &str,
        manifest_bytes: &[u8],
        have: &[u8],
    ) -> Option<Self> {
        let mut rx = Self::create(profile, width, height)?;
        let m = decode_manifest(manifest_bytes)?;
        // The code is parsed and its check character verified before anything is
        // trusted; a typo must not silently resume at the wrong chunk.
        let rc = ResumeCode::decode(code).ok()?;
        rx.install_manifest(m);
        let n = rx.done.len();
        if rc.chunk as usize > n {
            return None;
        }
        for i in 0..n {
            let byte = have.get(i / 8).copied().unwrap_or(0);
            if (byte >> (i % 8)) & 1 == 1 {
                rx.done[i] = true;
            }
        }
        Some(rx)
    }

    /// Verify one chunk of already-written output against the manifest BLAKE3.
    /// This is how the caller builds an honest `haveChunks` bitmap from OPFS: wasm
    /// cannot read the file itself (ADR-0008 puts the handle on the JS side).
    pub fn verify_chunk(&self, index: usize, plain: &[u8]) -> bool {
        let Some(m) = &self.manifest else {
            return false;
        };
        let Some(meta) = m.chunks.get(index) else {
            return false;
        };
        plain.len() == meta.plain_len as usize && *blake3::hash(plain).as_bytes() == meta.hash
    }

    pub fn set_geometry(&mut self, on: bool) {
        self.geometry = on;
    }

    pub fn set_profile(&mut self, p: Profile) -> bool {
        let spec = geometry::frame_spec(self.spec.width, self.spec.height, p.cell());
        if header::header_copies(&spec, p.palette()) == 0 {
            return false;
        }
        self.profile = p;
        self.spec = spec;
        self.pal = p.palette();
        true
    }

    pub fn profile(&self) -> Profile {
        self.profile
    }

    pub fn frame_buffer(&mut self) -> (*mut u8, usize) {
        (self.frame.as_mut_ptr(), self.frame.len())
    }

    pub fn frame_slice_mut(&mut self) -> &mut [u8] {
        &mut self.frame
    }

    pub fn manifest(&self) -> Option<&Manifest> {
        self.manifest.as_ref()
    }

    pub fn frames_seen(&self) -> u64 {
        self.frames_seen
    }

    pub fn frames_accepted(&self) -> u64 {
        self.frames_accepted
    }

    fn install_manifest(&mut self, m: Manifest) {
        self.done = vec![false; m.chunk_count as usize];
        self.manifest = Some(m);
        let pend: Vec<(u32, Vec<u8>)> = self.pending.drain().collect();
        for (i, stored) in pend {
            self.finish_chunk(i, stored);
        }
    }

    /// gunzip (if the transfer is gzipped) and verify against the manifest hash,
    /// then queue the plaintext for `take_chunk`.
    fn finish_chunk(&mut self, index: u32, stored: Vec<u8>) -> bool {
        let Some(m) = &self.manifest else {
            self.pending.insert(index, stored);
            return false;
        };
        let Some(meta) = m.chunks.get(index as usize).cloned() else {
            return false;
        };
        // The fountain pads its last source symbol; trim back to the wire length.
        let mut stored = stored;
        if stored.len() > meta.stored_len as usize {
            stored.truncate(meta.stored_len as usize);
        }
        if stored.len() != meta.stored_len as usize {
            return false;
        }
        let plain = match m.encoding {
            Encoding::Raw => stored,
            Encoding::Gzip => match pipeline::gunzip(&stored, meta.plain_len as usize) {
                Ok(p) => p,
                Err(_) => return false,
            },
        };
        if plain.len() != meta.plain_len as usize {
            return false;
        }
        if *blake3::hash(&plain).as_bytes() != meta.hash {
            return false;
        }
        if let Some(d) = self.done.get_mut(index as usize) {
            if *d {
                return false;
            }
            *d = true;
        }
        self.ready.push_back((index, plain));
        true
    }

    /// Decode whatever is currently in the frame buffer.
    pub fn push_frame(&mut self) -> PushResult {
        self.frames_seen += 1;
        let (reference, quality) = measure_reference_rgba(&self.frame, &self.spec, self.pal);
        self.quality = quality;

        // Fast path: the aligned grid, sampled straight out of the RGBA the camera
        // wrote. No copy, no allocation beyond the two symbol vectors (reused).
        let mut hdr = std::mem::take(&mut self.hdr_syms);
        let mut pay = std::mem::take(&mut self.pay_syms);
        sample_band_rgba(
            &self.frame,
            &self.spec,
            self.pal,
            &reference,
            self.spec.header_row0(),
            self.spec.header_rows(),
            &mut hdr,
        );
        sample_band_rgba(
            &self.frame,
            &self.spec,
            self.pal,
            &reference,
            self.spec.payload_row0(),
            self.spec.payload_rows(),
            &mut pay,
        );
        let mut decoded = header::decode_symbols(&hdr, &pay, &self.spec, self.pal);
        self.hdr_syms = hdr;
        self.pay_syms = pay;
        let mut rectified = false;

        // Slow path: the frame is warped, so find the fiducials and rectify. This
        // is the only place an RGB copy of the frame is made.
        if decoded.is_none() && self.geometry {
            rgba_to_rgb(&self.frame, &mut self.rgb.data);
            match geometry::fit_geometry(&self.rgb, &self.spec) {
                Some(fit) => {
                    let warped = geometry::warp_with(&self.rgb, &self.spec, &fit);
                    decoded = header::decode_frame(&warped, &self.spec, self.pal);
                    rectified = true;
                }
                None => {
                    return PushResult {
                        accepted: false,
                        reason: Some(DropReason::NoFiducials),
                        chunk_complete: None,
                        needed_more: self.needed_more(),
                        quality,
                        rectified: false,
                    }
                }
            }
        }

        let Some(df) = decoded else {
            return PushResult {
                accepted: false,
                reason: Some(DropReason::BadCrc),
                chunk_complete: None,
                needed_more: self.needed_more(),
                quality,
                rectified,
            };
        };

        let seq = df.header.seq;
        let oti = df.header.oti;

        if seq == MANIFEST_SEQ {
            if self.manifest.is_some() {
                return PushResult {
                    accepted: false,
                    reason: Some(DropReason::Duplicate),
                    chunk_complete: None,
                    needed_more: self.needed_more(),
                    quality,
                    rectified,
                };
            }
            if self.manifest_fx.is_none() {
                match fountain::Receiver::from_oti(oti) {
                    Ok(r) => self.manifest_fx = Some(r),
                    Err(_) => {
                        return PushResult {
                            accepted: false,
                            reason: Some(DropReason::BadCrc),
                            chunk_complete: None,
                            needed_more: self.needed_more(),
                            quality,
                            rectified,
                        }
                    }
                }
            }
            let fx = self.manifest_fx.as_mut().unwrap();
            let fresh = fx.push(&df.payload);
            let finished = fx.finish();
            if let Some(bytes) = finished {
                if let Some(m) = decode_manifest(&bytes) {
                    self.install_manifest(m);
                }
            }
            self.frames_accepted += fresh as u64;
            return PushResult {
                accepted: fresh,
                reason: if fresh {
                    None
                } else {
                    Some(DropReason::Duplicate)
                },
                chunk_complete: None,
                needed_more: self.needed_more(),
                quality,
                rectified,
            };
        }

        if self.done.get(seq as usize).copied().unwrap_or(false) {
            return PushResult {
                accepted: false,
                reason: Some(DropReason::Duplicate),
                chunk_complete: None,
                needed_more: self.needed_more(),
                quality,
                rectified,
            };
        }

        let entry = match self.chunk_fx.entry(seq) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => match fountain::Receiver::from_oti(oti)
            {
                Ok(r) => v.insert(r),
                Err(_) => {
                    return PushResult {
                        accepted: false,
                        reason: Some(DropReason::BadCrc),
                        chunk_complete: None,
                        needed_more: self.needed_more(),
                        quality,
                        rectified,
                    }
                }
            },
        };
        let fresh = entry.push(&df.payload);
        let finished = if entry.is_complete() {
            entry.finish()
        } else {
            None
        };
        let mut complete = None;
        if let Some(stored) = finished {
            self.chunk_fx.remove(&seq);
            if self.finish_chunk(seq, stored) {
                complete = Some(seq);
            }
        }
        self.frames_accepted += fresh as u64;
        PushResult {
            accepted: fresh,
            reason: if fresh {
                None
            } else {
                Some(DropReason::Duplicate)
            },
            chunk_complete: complete,
            needed_more: self.needed_more(),
            quality,
            rectified,
        }
    }

    /// The ADR-0005 integer: frames still wanted for the chunk in flight. Zero only
    /// when the whole transfer is complete.
    pub fn needed_more(&self) -> u32 {
        if self.is_complete() {
            return 0;
        }
        if self.manifest.is_none() {
            return match &self.manifest_fx {
                Some(fx) => fx.needed_more().max(1) as u32,
                None => 1,
            };
        }
        let Some(first) = self.done.iter().position(|d| !*d) else {
            return 0;
        };
        match self.chunk_fx.get(&(first as u32)) {
            Some(fx) => fx.needed_more().max(1) as u32,
            None => 1,
        }
    }

    pub fn is_complete(&self) -> bool {
        self.manifest.is_some() && !self.done.is_empty() && self.done.iter().all(|d| *d)
    }

    pub fn completed_chunks(&self) -> usize {
        self.done.iter().filter(|d| **d).count()
    }

    pub fn first_missing(&self) -> usize {
        self.done
            .iter()
            .position(|d| !*d)
            .unwrap_or(self.done.len())
    }

    pub fn resume_code(&self) -> String {
        ResumeCode::new(self.first_missing() as u32, self.needed_more()).encode()
    }

    pub fn display_code(&self) -> Option<String> {
        self.manifest.as_ref().map(|m| m.display_code())
    }

    pub fn quality(&self) -> f32 {
        self.quality
    }

    /// Force the full geometry path — fiducial detection, lens-term search, warp,
    /// decode — on whatever is in the frame buffer, ignoring the aligned fast path.
    /// Exists so the harness can price rectification, which is the cost that decides
    /// whether S8 can hold 30 FPS on a hand-held camera.
    pub fn geometry_only(&mut self) -> bool {
        rgba_to_rgb(&self.frame, &mut self.rgb.data);
        match geometry::fit_geometry(&self.rgb, &self.spec) {
            Some(fit) => {
                let warped = geometry::warp_with(&self.rgb, &self.spec, &fit);
                header::decode_frame(&warped, &self.spec, self.pal).is_some()
            }
            None => false,
        }
    }

    /// Hand the caller the next verified chunk. The bytes live in a buffer owned by
    /// the receiver and are valid until the next `take_chunk`.
    pub fn take_chunk(&mut self) -> Option<(u32, *const u8, usize)> {
        let (index, plain) = self.ready.pop_front()?;
        self.take = plain;
        Some((index, self.take.as_ptr(), self.take.len()))
    }
}

#[inline]
fn rgba_to_rgb(src: &[u8], dst: &mut [u8]) {
    let n = (src.len() / 4).min(dst.len() / 3);
    for i in 0..n {
        dst[i * 3] = src[i * 4];
        dst[i * 3 + 1] = src[i * 4 + 1];
        dst[i * 3 + 2] = src[i * 4 + 2];
    }
}

// ---------------------------------------------------------------------------
// helpers shared with the native bench
// ---------------------------------------------------------------------------

/// Bytes of payload one frame carries at this profile — the S4 frontier number.
pub fn frame_capacity(profile: Profile, width: usize, height: usize) -> usize {
    let spec = geometry::frame_spec(width, height, profile.cell());
    spec.capacity_bytes(profile.palette())
}

/// Symbols per frame, for cost accounting.
pub fn frame_cells(profile: Profile, width: usize, height: usize) -> usize {
    let spec = geometry::frame_spec(width, height, profile.cell());
    spec.header_cells() + spec.payload_cells() + spec.cols()
}

/// Sanity re-export so the bench binary does not need `optical_core` directly.
pub fn symbol_error_rate(a: &[u8], b: &[u8]) -> f64 {
    modem::symbol_error_rate(a, b)
}

pub fn bytes_for_symbols(n: usize, bits: u32) -> usize {
    codec::bytes_for_symbols(n, bits)
}
