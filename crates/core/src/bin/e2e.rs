//! probe
use optical_core::header::{self, FrameHeader};
use optical_core::sim::Channel;
use optical_core::{geometry, modem, Palette, P8};
use std::time::Instant;

fn main() {
    for (name, ch, cell) in [
        ("good", Channel::good_handheld(), 8usize),
        ("webcam", Channel::webcam_handheld(), 8),
        ("potato", Channel::potato_handheld(), 20),
    ] {
        let pal: &Palette = &P8;
        let spec = geometry::frame_spec(1920, 1080, cell);
        let cap = spec.capacity_bytes(pal);
        let payload: Vec<u8> = (0..cap).map(|i| (i * 7 + 3) as u8).collect();
        let h = FrameHeader::new(1, cap as u16, [0u8; 12]);
        let t0 = Instant::now();
        let mut img = header::encode_frame(&h, &payload, &spec, pal).unwrap();
        geometry::stamp_fiducials(&mut img, &spec);
        let t1 = Instant::now();
        let seen = ch.apply(&img);
        let t2 = Instant::now();
        let rect = geometry::rectify(&seen, &spec);
        let t3 = Instant::now();
        let dec = rect.as_ref().and_then(|r| header::decode_frame(r, &spec, pal));
        let t4 = Instant::now();
        println!(
            "{name:8} cap={cap} enc={:?} chan={:?} rect={:?} dec={:?} ok={} match={}",
            t1 - t0,
            t2 - t1,
            t3 - t2,
            t4 - t3,
            dec.is_some(),
            dec.map(|d| d.payload == payload).unwrap_or(false),
        );
        let _ = modem::symbol_error_rate(&[], &[]);
    }
}
