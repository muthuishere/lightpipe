//! End-to-end regression: the whole chain in one pass, kept small enough that
//! `cargo test` stays usable. The large sweeps live in `src/bin/e2e.rs`.
//!
//! file -> chunk+gzip+manifest -> RaptorQ -> header+CRC -> cells -> fiducials
//!      -> channel -> rectify -> CRC -> fountain -> BLAKE3 -> write at offset.

use optical_core::header::{self, FrameHeader};
use optical_core::pipeline::{
    ChunkFountain, Config, Encoder, Encoding, PacketCollector, PacketEmitter, RaptorqFountain,
    Receiver, ResumeCode, SparseSink, StubFountain,
};
use optical_core::sim::Channel;
use optical_core::{geometry, FrameSpec, Palette, P8};

/// Full 1080p, the geometry every measured number in `docs/spikes` is defined on.
const W: usize = 1920;
const H: usize = 1080;
/// Half-size canvas for the tests that exercise *protocol* behaviour (tear
/// erasures, resume) rather than optics. Same code path, a quarter of the pixels,
/// which is what keeps `cargo test` under half a minute in a debug build.
const SW: usize = 960;
const SH: usize = 540;
/// 16 KB chunks keep the test to a handful of frames. The product default is
/// 256 KB (ADR-0006) — nothing here should be read as a capacity measurement.
const TEST_CHUNK: usize = 16 * 1024;

fn corpus(n: usize) -> Vec<u8> {
    let mut x: u32 = 0xC0FF_EE11;
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        // Compressible, so the gzip stage of the chain does real work (ADR-0014
        // compresses either way).
        out.extend_from_slice(b"the quick brown packet jumps over the lazy fountain ");
        out.push((x >> 24) as u8);
    }
    out.truncate(n);
    out
}

struct Rig {
    spec: FrameSpec,
    pal: &'static Palette,
    ch: Channel,
}

impl Rig {
    /// A 1080p rig at one of the S4 clean rungs.
    fn new(ch: Channel, cell: usize) -> Self {
        Self {
            spec: geometry::frame_spec(W, H, cell),
            pal: &P8,
            ch,
        }
    }

    /// Half-size rig: for protocol tests, not for optical claims.
    fn small(ch: Channel, cell: usize) -> Self {
        Self {
            spec: geometry::frame_spec(SW, SH, cell),
            pal: &P8,
            ch,
        }
    }

    fn capacity(&self) -> usize {
        self.spec.capacity_bytes(self.pal)
    }

    /// render -> fiducials -> channel -> rectify -> CRC. `None` is an erasure.
    fn shoot(&self, seq: u32, oti: [u8; 12], packet: &[u8]) -> Option<header::DecodedFrame> {
        let hdr = FrameHeader::new(seq, packet.len() as u16, oti);
        let mut img =
            header::encode_frame(&hdr, packet, &self.spec, self.pal).expect("packet fits");
        assert!(geometry::stamp_fiducials(&mut img, &self.spec));
        let seen = self.ch.apply(&img);
        let rect = geometry::rectify(&seen, &self.spec)?;
        header::decode_frame(&rect, &self.spec, self.pal)
    }
}

/// One whole transfer. Returns (frames emitted, frames decoded, output bytes).
fn transfer(rig: &Rig, data: &[u8], sink: SparseSink) -> (usize, usize, SparseSink, String) {
    let fountain = RaptorqFountain::new(rig.capacity());
    let cfg = Config::default().with_chunk_size(TEST_CHUNK);
    let mut enc = Encoder::build(data, cfg);
    let manifest = enc.manifest().clone();
    let n = manifest.chunk_count as usize;
    let mut rx = Receiver::new(manifest.clone(), sink);

    let mut emitted = 0;
    let mut decoded = 0;
    // Reverse order: chunks land at their byte offsets out of order (ADR-0008).
    for ci in (0..n).rev() {
        let payload = enc.chunk_payload(ci).expect("chunk");
        let mut tx = fountain.emitter(&payload);
        let oti = tx.oti();
        let mut col = None;
        loop {
            let packet = tx.next_packet();
            emitted += 1;
            assert!(emitted < 4000, "transfer is not converging");
            let Some(df) = rig.shoot(ci as u32, oti, &packet) else {
                continue;
            };
            decoded += 1;
            let col = col.get_or_insert_with(|| {
                fountain
                    .collector_from_oti(df.header.oti)
                    .expect("header carried a usable OTI")
            });
            if let Some(stored) = col.absorb(&df.payload) {
                rx.accept(ci, &stored).expect("chunk verifies");
                assert_eq!(col.needed(), 0);
                break;
            }
        }
    }
    assert!(rx.is_complete());
    let hash = rx.verify_file().expect("whole-file BLAKE3");
    let code = optical_core::pipeline::display_code(&hash);
    (emitted, decoded, rx.into_sink(), code)
}

#[test]
fn webcam_handheld_delivers_a_byte_identical_file() {
    let rig = Rig::new(Channel::webcam_handheld(), 8);
    let data = corpus(48 * 1024);
    let (emitted, decoded, mut sink, code) = transfer(&rig, &data, SparseSink::new());
    assert_eq!(sink.to_vec(), data, "file must be byte-identical");
    // Sender and receiver show the same six characters (ADR-0005).
    let manifest = Encoder::build(
        data.as_slice(),
        Config::default().with_chunk_size(TEST_CHUNK),
    )
    .manifest()
    .clone();
    assert_eq!(manifest.display_code(), code);
    // ADR-0014: every chunk of every transfer is gzipped, unconditionally.
    assert_eq!(manifest.encoding, Encoding::Gzip);
    assert!(decoded <= emitted);
    // No frame drops are expected at the S4 clean rung; if that ever changes,
    // the fountain still has to cover it, so this is a bound, not an equality.
    assert!(emitted <= decoded * 2);
}

#[test]
fn potato_handheld_completes_at_the_l0_rung() {
    // ADR-0011's binding case: the worst camera must finish, only slower.
    let rig = Rig::new(Channel::potato_handheld(), 20);
    let data = corpus(8 * 1024);
    let (_, _, mut sink, _) = transfer(&rig, &data, SparseSink::new());
    assert_eq!(sink.to_vec(), data);
}

#[test]
fn a_torn_frame_is_an_erasure_the_fountain_covers() {
    // Rolling-shutter tear: rows above the seam come from the previous render.
    let rig = Rig::small(Channel::webcam_handheld(), 8);
    let fountain = RaptorqFountain::new(rig.capacity());
    let payload = corpus(5 * 1024);
    let mut tx = fountain.emitter(&payload);
    let oti = tx.oti();
    let mut col = fountain
        .collector_from_oti(oti)
        .expect("oti round-trips through the header");

    let mut prev = vec![0u8; rig.capacity()];
    let mut emitted = 0usize;
    let mut dropped = 0usize;
    let got = loop {
        let packet = tx.next_packet();
        emitted += 1;
        assert!(emitted < 200, "tear must not stall the transfer");
        // Every third frame is torn across the middle.
        let df = if emitted.is_multiple_of(3) {
            let h = FrameHeader::new(0, packet.len() as u16, oti);
            let mut cur = header::encode_frame(&h, &packet, &rig.spec, rig.pal).unwrap();
            geometry::stamp_fiducials(&mut cur, &rig.spec);
            let hp = FrameHeader::new(0, prev.len() as u16, oti);
            let mut old = header::encode_frame(&hp, &prev, &rig.spec, rig.pal).unwrap();
            geometry::stamp_fiducials(&mut old, &rig.spec);
            let seen = rig.ch.with_tear(0.5).apply_pair(&cur, &old);
            geometry::rectify(&seen, &rig.spec)
                .and_then(|r| header::decode_frame(&r, &rig.spec, rig.pal))
        } else {
            rig.shoot(0, oti, &packet)
        };
        prev = packet;
        match df {
            None => dropped += 1,
            Some(df) => {
                if let Some(done) = col.absorb(&df.payload) {
                    break done;
                }
            }
        }
    };
    assert_eq!(got, payload, "fountain rebuilt the chunk despite the tears");
    assert!(dropped > 0, "the tear must actually cost frames");
    assert_eq!(col.needed(), 0);
}

#[test]
fn kill_at_seventy_percent_and_resume_from_the_typed_code() {
    let rig = Rig::small(Channel::webcam_handheld(), 8);
    let data = corpus(16 * 1024);
    // 4 KB chunks: four units of progress in as few frames as possible. The
    // product default is 256 KB (ADR-0006) — this is a protocol test, not a
    // compression measurement.
    let cfg = Config::default().with_chunk_size(4 * 1024);
    let manifest = Encoder::build(data.as_slice(), cfg).manifest().clone();
    let n = manifest.chunk_count as usize;
    let keep = n * 3 / 4;
    assert!(keep >= 2 && keep < n);

    // Deliver the first `keep` chunks, then die.
    let fountain = RaptorqFountain::new(rig.capacity());
    let mut enc = Encoder::build(data.as_slice(), cfg);
    let mut rx = Receiver::new(manifest.clone(), SparseSink::new());
    let mut last_need = 0;
    for ci in 0..keep {
        let payload = enc.chunk_payload(ci).unwrap();
        let mut tx = fountain.emitter(&payload);
        let oti = tx.oti();
        let mut col = fountain.collector_from_oti(oti).unwrap();
        loop {
            let p = tx.next_packet();
            let Some(df) = rig.shoot(ci as u32, oti, &p) else {
                continue;
            };
            last_need = col.needed();
            if let Some(stored) = col.absorb(&df.payload) {
                rx.accept(ci, &stored).unwrap();
                break;
            }
        }
    }
    let typed = rx.resume_code(last_need).encode();
    let partial = rx.into_sink();

    // A fresh receiver, given only the manifest, the partial file, and the code.
    let parsed = ResumeCode::decode(&typed.to_lowercase()).expect("typed code parses");
    let (mut rx2, verified) =
        Receiver::resume(manifest.clone(), partial, &parsed).expect("resume accepted");
    assert_eq!(verified, keep, "retained chunks re-verify off the sink");

    for ci in rx2.missing() {
        let payload = enc.chunk_payload(ci).unwrap();
        let mut tx = fountain.emitter(&payload);
        let oti = tx.oti();
        let mut col = fountain.collector_from_oti(oti).unwrap();
        loop {
            let p = tx.next_packet();
            let Some(df) = rig.shoot(ci as u32, oti, &p) else {
                continue;
            };
            if let Some(stored) = col.absorb(&df.payload) {
                rx2.accept(ci, &stored).unwrap();
                break;
            }
        }
    }
    assert!(rx2.is_complete());
    assert!(rx2.verify_file().is_ok());
    assert_eq!(rx2.into_sink().to_vec(), data);
}

#[test]
fn a_hopeless_camera_fails_loudly_and_fast() {
    // ADR-0011: "must fail loudly and immediately, never hang at 0%."
    let ch = Channel {
        blur_sigma: 9.0,
        resample: 0.14,
        noise: 40.0,
        jpeg: 0.9,
        vignette: 0.5,
        ..Channel::potato_handheld()
    };
    // Half-size canvas: sigma-9 blur over 1080p costs seconds per frame and this
    // test is about the *failure mode*, not about optics.
    let rig = Rig::small(ch, 20);
    let packet = vec![0xA5u8; rig.capacity()];
    for i in 0..3u32 {
        // No fiducials -> rectify() is None -> the UI can say "cannot see the
        // code" on the first frame instead of counting down forever.
        assert!(
            rig.shoot(i, [0u8; 12], &packet).is_none(),
            "nothing may decode on a hopeless channel"
        );
    }
}

#[test]
fn raptorq_and_the_stub_agree_through_the_same_seam() {
    // The pipeline must depend on no fountain property beyond the seam, so the
    // coding-free stub and the real RaptorQ have to be interchangeable.
    let payload = corpus(5_000);
    let cap = 1_182; // the potato rung
    for (name, out) in [
        ("stub", drain(&StubFountain { packet_bytes: cap }, &payload)),
        ("raptorq", drain(&RaptorqFountain::new(cap), &payload)),
    ] {
        assert_eq!(out, payload, "{name} must rebuild the chunk");
    }
}

fn drain<F: ChunkFountain>(f: &F, payload: &[u8]) -> Vec<u8> {
    let mut tx = f.emitter(payload);
    let mut col = f.collector(payload.len());
    for _ in 0..10_000 {
        let p = tx.next_packet();
        if let Some(done) = col.absorb(&p) {
            assert_eq!(col.needed(), 0);
            return done;
        }
    }
    panic!("fountain never completed");
}
