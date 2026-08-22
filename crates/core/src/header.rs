//! Frame header band + CRC32 frame integrity (S2, ADR-0004).
//!
//! Layout of a frame, top to bottom:
//!
//! ```text
//!   row 0                  calibration strip (FrameSpec::CALIB_ROWS)
//!   rows 1..1+HEADER_ROWS   header band: the 25-byte record, repeated
//!   rows below              payload cells
//! ```
//!
//! The record is written as many times as fits across the band. The decoder
//! tries each copy in order and accepts the first whose CRC32 validates against
//! the recovered payload — the CRC is the arbiter, so no majority voting is
//! needed and a single surviving copy is enough.
//!
//! A frame whose header never validates is dropped **entirely**: it becomes an
//! erasure for the fountain layer (ADR-0004). Nothing is ever partially trusted.

use crate::codec;
use crate::frame::FrameSpec;
use crate::image::RgbImage;
use crate::modem;
use crate::palette::Palette;

/// "TQ" — transfer-qr.
pub const MAGIC: u16 = 0x5451;
/// Wire format version of the header record.
pub const VERSION: u8 = 1;
/// RaptorQ Object Transmission Information, carried opaquely (the fountain layer
/// owns its meaning; this layer only guarantees it arrives intact).
pub const OTI_LEN: usize = 12;
/// Serialized size of one header copy.
pub const HEADER_BYTES: usize = 25;
/// Bytes of the record covered by the CRC (everything before the CRC itself).
const CRC_OFFSET: usize = 21;

/// ```text
///  offset  size  field
///   0      2     magic        u16 big-endian
///   2      1     version      u8
///   3      4     seq          u32 big-endian
///   7      2     payload_len  u16 big-endian
///   9     12     oti          opaque
///  21      4     crc32        u32 big-endian, over bytes 0..21 ++ payload[..payload_len]
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub magic: u16,
    pub version: u8,
    pub seq: u32,
    pub payload_len: u16,
    pub oti: [u8; OTI_LEN],
}

/// A frame that passed its CRC. Produced only as a whole, never in part.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedFrame {
    pub header: FrameHeader,
    pub payload: Vec<u8>,
}

impl FrameHeader {
    pub fn new(seq: u32, payload_len: u16, oti: [u8; OTI_LEN]) -> Self {
        Self {
            magic: MAGIC,
            version: VERSION,
            seq,
            payload_len,
            oti,
        }
    }

    /// Serialize, with the CRC computed over the header fields **and** `payload`.
    pub fn to_bytes(&self, payload: &[u8]) -> [u8; HEADER_BYTES] {
        let mut b = [0u8; HEADER_BYTES];
        b[0..2].copy_from_slice(&self.magic.to_be_bytes());
        b[2] = self.version;
        b[3..7].copy_from_slice(&self.seq.to_be_bytes());
        b[7..9].copy_from_slice(&self.payload_len.to_be_bytes());
        b[9..21].copy_from_slice(&self.oti);
        let crc = crc(&b[..CRC_OFFSET], payload);
        b[21..25].copy_from_slice(&crc.to_be_bytes());
        b
    }

    /// Parse one copy. Returns the record and the CRC it claims. Rejects a wrong
    /// magic or version outright — a cheap first filter before the CRC.
    fn parse(b: &[u8]) -> Option<(Self, u32)> {
        if b.len() < HEADER_BYTES {
            return None;
        }
        let magic = u16::from_be_bytes([b[0], b[1]]);
        if magic != MAGIC || b[2] != VERSION {
            return None;
        }
        let mut oti = [0u8; OTI_LEN];
        oti.copy_from_slice(&b[9..21]);
        let h = Self {
            magic,
            version: b[2],
            seq: u32::from_be_bytes([b[3], b[4], b[5], b[6]]),
            payload_len: u16::from_be_bytes([b[7], b[8]]),
            oti,
        };
        let claimed = u32::from_be_bytes([b[21], b[22], b[23], b[24]]);
        Some((h, claimed))
    }
}

fn crc(header_fields: &[u8], payload: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(header_fields);
    h.update(payload);
    h.finalize()
}

/// Symbols one header copy occupies at this palette.
pub fn symbols_per_copy(pal: &Palette) -> usize {
    codec::symbols_for_bytes(HEADER_BYTES, pal.bits)
}

/// How many complete copies of the record fit in the header band.
pub fn header_copies(spec: &FrameSpec, pal: &Palette) -> usize {
    spec.header_cells() / symbols_per_copy(pal)
}

/// Header overhead of a frame in bytes: the whole band, whether or not the last
/// part of it holds a complete copy.
pub fn header_overhead_bytes(spec: &FrameSpec, pal: &Palette) -> usize {
    spec.header_band_bytes(pal)
}

/// Encode header + payload into symbol bands: `(header_symbols, payload_symbols)`.
/// `None` when the payload does not fit or the band cannot hold one full copy.
pub fn encode_symbols(
    header: &FrameHeader,
    payload: &[u8],
    spec: &FrameSpec,
    pal: &Palette,
) -> Option<(Vec<u8>, Vec<u8>)> {
    let cap = spec.capacity_bytes(pal);
    if payload.len() > cap || payload.len() > u16::MAX as usize {
        return None;
    }
    let copies = header_copies(spec, pal);
    if copies == 0 {
        return None;
    }

    let mut h = *header;
    h.magic = MAGIC;
    h.version = VERSION;
    h.payload_len = payload.len() as u16;
    let record = h.to_bytes(payload);

    // Each copy is packed independently, so every copy starts byte-aligned in
    // symbol space and can be lifted out without touching its neighbours.
    let spc = symbols_per_copy(pal);
    let one = codec::bytes_to_symbols(&record, pal.bits);
    let mut hdr_syms = vec![0u8; spec.header_cells()];
    for i in 0..copies {
        hdr_syms[i * spc..i * spc + one.len()].copy_from_slice(&one);
    }

    let mut buf = vec![0u8; cap];
    buf[..payload.len()].copy_from_slice(payload);
    let mut pay_syms = codec::bytes_to_symbols(&buf, pal.bits);
    pay_syms.resize(spec.payload_cells(), 0);

    Some((hdr_syms, pay_syms))
}

/// Try every header copy against the recovered payload; return the first that
/// validates. `None` means the frame is an erasure.
pub fn decode_symbols(
    header_syms: &[u8],
    payload_syms: &[u8],
    spec: &FrameSpec,
    pal: &Palette,
) -> Option<DecodedFrame> {
    let cap = spec.capacity_bytes(pal);
    let payload_bytes = codec::symbols_to_bytes(payload_syms, pal.bits, cap);

    let spc = symbols_per_copy(pal);
    let copies = header_copies(spec, pal);
    for i in 0..copies {
        let end = (i + 1) * spc;
        if end > header_syms.len() {
            break;
        }
        let raw = codec::symbols_to_bytes(&header_syms[i * spc..end], pal.bits, HEADER_BYTES);
        let Some((h, claimed)) = FrameHeader::parse(&raw) else {
            continue;
        };
        let len = h.payload_len as usize;
        if len > cap {
            continue;
        }
        if crc(&raw[..CRC_OFFSET], &payload_bytes[..len]) != claimed {
            continue;
        }
        return Some(DecodedFrame {
            header: h,
            payload: payload_bytes[..len].to_vec(),
        });
    }
    None
}

/// Render a complete frame: calibration strip, header band, payload.
pub fn encode_frame(
    header: &FrameHeader,
    payload: &[u8],
    spec: &FrameSpec,
    pal: &Palette,
) -> Option<RgbImage> {
    let (hdr_syms, pay_syms) = encode_symbols(header, payload, spec, pal)?;
    let mut img = RgbImage::new(spec.width, spec.height);
    modem::render_calibration(&mut img, spec, pal);
    modem::render_band(
        &mut img,
        &hdr_syms,
        spec,
        pal,
        spec.header_row0(),
        spec.header_rows(),
    );
    modem::render_band(
        &mut img,
        &pay_syms,
        spec,
        pal,
        spec.payload_row0(),
        spec.payload_rows(),
    );
    Some(img)
}

/// Decode a captured frame. `None` when no header copy validates — the frame is
/// dropped whole and becomes an erasure for the fountain layer (ADR-0004).
pub fn decode_frame(img: &RgbImage, spec: &FrameSpec, pal: &Palette) -> Option<DecodedFrame> {
    let reference = modem::measure_reference(img, spec, pal);
    let hdr_syms = modem::sample_band(
        img,
        spec,
        pal,
        &reference,
        spec.header_row0(),
        spec.header_rows(),
    );
    let pay_syms = modem::sample_band(
        img,
        spec,
        pal,
        &reference,
        spec.payload_row0(),
        spec.payload_rows(),
    );
    decode_symbols(&hdr_syms, &pay_syms, spec, pal)
}
