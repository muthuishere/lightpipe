//! S2 — frame integrity. Header band + CRC32 (ADR-0004).
//! No hardware, no browser (ADR-0009, ADR-0010).

use optical_core::header::{self, FrameHeader, HEADER_BYTES};
use optical_core::sim::Channel;
use optical_core::{FrameSpec, Palette, P4, P8};

struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| (self.next_u64() >> 24) as u8).collect()
    }
    fn oti(&mut self) -> [u8; 12] {
        let mut o = [0u8; 12];
        o.copy_from_slice(&self.bytes(12));
        o
    }
}

/// The payload origin must sit below both the calibration strip and the header
/// band, and capacity must account for the band.
#[test]
fn payload_origin_is_below_the_header_band() {
    for cell in [8usize, 10, 14, 20] {
        let spec = FrameSpec::new(1920, 1080, cell);
        assert_eq!(spec.header_row0(), FrameSpec::CALIB_ROWS);
        assert_eq!(
            spec.payload_row0(),
            FrameSpec::CALIB_ROWS + FrameSpec::HEADER_ROWS
        );
        assert_eq!(spec.header_rows(), FrameSpec::HEADER_ROWS);
        assert_eq!(
            spec.payload_rows() + FrameSpec::CALIB_ROWS + FrameSpec::HEADER_ROWS,
            spec.rows()
        );
        for pal in [&P4, &P8] {
            assert_eq!(
                spec.capacity_bytes(pal),
                spec.payload_cells() * pal.bits as usize / 8
            );
            assert!(header::header_copies(&spec, pal) >= 1);
        }
    }
}

/// S2 acceptance 2: clean frames round-trip exactly, P4/P8 x cell {8,10,14}.
#[test]
fn s2_clean_frames_roundtrip_exactly() {
    let ideal = Channel::ideal();
    let mut rng = Rng(0x1234_5678_9ABC_DEF1);
    for pal in [&P4, &P8] {
        for cell in [8usize, 10, 14] {
            let spec = FrameSpec::new(1920, 1080, cell);
            let cap = spec.capacity_bytes(pal);
            for seq in 0..3u32 {
                let payload = rng.bytes(cap);
                let oti = rng.oti();
                let h = FrameHeader::new(seq, cap as u16, oti);
                let img = header::encode_frame(&h, &payload, &spec, pal).expect("encode");
                let d = header::decode_frame(&ideal.apply(&img), &spec, pal).unwrap_or_else(|| {
                    panic!("{} cell={cell} seq={seq}: no header validated", pal.name)
                });
                assert_eq!(d.payload, payload, "{} cell={cell}", pal.name);
                assert_eq!(d.header.seq, seq);
                assert_eq!(d.header.oti, oti);
                assert_eq!(d.header.payload_len as usize, cap);
                assert_eq!(d.header.magic, header::MAGIC);
                assert_eq!(d.header.version, header::VERSION);
            }
        }
    }
}

/// Short payloads (the last frame of a transfer) must round-trip too.
#[test]
fn short_payloads_roundtrip() {
    let spec = FrameSpec::new(1920, 1080, 10);
    let mut rng = Rng(0xFEED_FACE_0BAD_C0DE);
    for len in [0usize, 1, 2, 25, 1000] {
        let payload = rng.bytes(len);
        let h = FrameHeader::new(len as u32, 0, rng.oti());
        let img = header::encode_frame(&h, &payload, &spec, &P4).expect("encode");
        let d = header::decode_frame(&img, &spec, &P4).expect("decode");
        assert_eq!(d.payload, payload);
        assert_eq!(d.header.payload_len as usize, len);
    }
}

/// S2 acceptance 1 (test-suite sized; spike2 runs the full 100k).
/// A corrupted frame is either rejected or returns byte-identical data. Never
/// anything in between — a false accept is a hard failure (ADR-0004).
#[test]
fn s2_corrupted_frames_are_never_falsely_accepted() {
    let mut rng = Rng(0x0BAD_5EED_1234_9999);
    let cases: [(&Palette, FrameSpec); 3] = [
        (&P4, FrameSpec::new(960, 540, 8)),
        (&P8, FrameSpec::new(960, 540, 8)),
        (&P8, FrameSpec::new(640, 360, 14)),
    ];
    let mut total = 0usize;
    for (pal, spec) in cases {
        let cap = spec.capacity_bytes(pal);
        for t in 0..4000u32 {
            let plen = 1 + rng.below(cap);
            let payload = rng.bytes(plen);
            let oti = rng.oti();
            let h = FrameHeader::new(t, plen as u16, oti);
            let (mut hdr, mut pay) =
                header::encode_symbols(&h, &payload, &spec, pal).expect("encode");
            let cells = hdr.len() + pay.len();
            let flips = 1 + rng.below(((cells as f64 * 0.30) as usize).max(1));
            for _ in 0..flips {
                let i = rng.below(cells);
                let cur = if i < hdr.len() {
                    hdr[i]
                } else {
                    pay[i - hdr.len()]
                };
                let mut v = rng.below(pal.len()) as u8;
                if v == cur {
                    v = (cur + 1) % pal.len() as u8;
                }
                if i < hdr.len() {
                    hdr[i] = v;
                } else {
                    pay[i - hdr.len()] = v;
                }
            }
            total += 1;
            if let Some(d) = header::decode_symbols(&hdr, &pay, &spec, pal) {
                assert_eq!(d.header, h, "false accept: header differs (trial {t})");
                assert_eq!(
                    d.payload, payload,
                    "FALSE ACCEPT: corrupt payload accepted as truth (trial {t})"
                );
            }
        }
    }
    assert_eq!(total, 12_000);
}

/// A frame whose header band is destroyed must be dropped whole, never guessed.
#[test]
fn a_destroyed_header_band_drops_the_frame() {
    let spec = FrameSpec::new(960, 540, 8);
    let mut rng = Rng(0xABCD_0000_1111_2222);
    let cap = spec.capacity_bytes(&P4);
    let payload = rng.bytes(cap);
    let h = FrameHeader::new(1, cap as u16, rng.oti());
    let (mut hdr, pay) = header::encode_symbols(&h, &payload, &spec, &P4).expect("encode");
    for s in hdr.iter_mut() {
        *s = 3;
    }
    assert!(header::decode_symbols(&hdr, &pay, &spec, &P4).is_none());
}

/// One surviving copy is enough: the CRC is the arbiter, not a vote.
#[test]
fn one_surviving_copy_is_enough() {
    let spec = FrameSpec::new(1920, 1080, 8);
    let mut rng = Rng(0x7777_8888_9999_AAAA);
    for pal in [&P4, &P8] {
        let copies = header::header_copies(&spec, pal);
        assert!(copies >= 2, "{} only fits {copies} copies", pal.name);
        let cap = spec.capacity_bytes(pal);
        let payload = rng.bytes(cap);
        let h = FrameHeader::new(42, cap as u16, rng.oti());
        let (base, pay) = header::encode_symbols(&h, &payload, &spec, pal).expect("encode");
        let spc = header::symbols_per_copy(pal);
        for keep in 0..copies {
            let mut hdr = base.clone();
            for (i, s) in hdr.iter_mut().enumerate() {
                if i / spc != keep {
                    *s = (i % pal.len()) as u8;
                }
            }
            let d = header::decode_symbols(&hdr, &pay, &spec, pal)
                .unwrap_or_else(|| panic!("{} keep={keep}: no copy validated", pal.name));
            assert_eq!(d.payload, payload);
            assert_eq!(d.header, h);
        }
    }
}

/// S2 acceptance 3: the header must survive the simulated cameras at the cell
/// sizes S1 showed clean. ADR-0011 is binding — the potato must not regress.
#[test]
fn s2_header_survives_the_simulated_cameras() {
    let mut rng = Rng(0x2222_3333_4444_5555);
    type Layers = &'static [(&'static Palette, usize)];
    let cases: [(&str, Channel, Layers); 2] = [
        (
            "webcam",
            Channel::webcam(),
            &[
                (&P4, 8),
                (&P4, 10),
                (&P4, 14),
                (&P8, 8),
                (&P8, 10),
                (&P8, 14),
            ],
        ),
        (
            "potato",
            Channel::potato(),
            &[(&P4, 14), (&P4, 20), (&P8, 14), (&P8, 20)],
        ),
    ];
    for (name, ch, layers) in cases {
        for (pal, cell) in layers {
            let spec = FrameSpec::new(1920, 1080, *cell);
            let cap = spec.capacity_bytes(pal);
            let payload = rng.bytes(cap);
            let h = FrameHeader::new(9, cap as u16, rng.oti());
            let img = header::encode_frame(&h, &payload, &spec, pal).expect("encode");
            let d = header::decode_frame(&ch.apply(&img), &spec, pal)
                .unwrap_or_else(|| panic!("{name} {} cell={cell}: frame dropped", pal.name));
            assert_eq!(d.payload, payload, "{name} {} cell={cell}", pal.name);
        }
    }
}

/// The wire format is fixed; changing it is a version bump, not an edit.
#[test]
fn header_record_is_25_bytes_and_stable() {
    assert_eq!(HEADER_BYTES, 25);
    let h = FrameHeader::new(0x0102_0304, 0x0506, [7u8; 12]);
    let b = h.to_bytes(&[]);
    assert_eq!(&b[0..2], &header::MAGIC.to_be_bytes());
    assert_eq!(b[2], header::VERSION);
    assert_eq!(&b[3..7], &[1, 2, 3, 4]);
    assert_eq!(&b[7..9], &[5, 6]);
    assert_eq!(&b[9..21], &[7u8; 12]);
    // The CRC covers the payload as well as the fields.
    assert_ne!(h.to_bytes(&[0u8; 4])[21..25], b[21..25]);
}
