//! S0/S1 regression tests. No hardware, no browser (ADR-0009, ADR-0010).

use optical_core::codec;
use optical_core::modem;
use optical_core::sim::Channel;
use optical_core::{FrameSpec, Palette, P4, P8};

const P2: Palette = Palette {
    name: "P2",
    colors: &[optical_core::palette::BLACK, optical_core::palette::WHITE],
    bits: 1,
};

fn prng_bytes(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed | 1;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 16) as u8
        })
        .collect()
}

fn roundtrip(pal: &Palette, cell: usize, ch: &Channel, seed: u32) -> (Vec<u8>, Vec<u8>, f64) {
    let spec = FrameSpec::new(1920, 1080, cell);
    let data = prng_bytes(spec.capacity_bytes(pal), seed);
    let syms = codec::bytes_to_symbols(&data, pal.bits);
    let frame = modem::render(&syms, &spec, pal);
    let got_syms = modem::sample(&ch.apply(&frame), &spec, pal);
    let got = codec::symbols_to_bytes(&got_syms, pal.bits, data.len());
    let ser = modem::symbol_error_rate(&syms, &got_syms);
    (data, got, ser)
}

#[test]
fn bit_packing_is_lossless() {
    for bits in 1..=8u32 {
        for seed in 0..64u32 {
            let data = prng_bytes(257, seed * 31 + bits);
            let syms = codec::bytes_to_symbols(&data, bits);
            let back = codec::symbols_to_bytes(&syms, bits, data.len());
            assert_eq!(data, back, "bits={bits} seed={seed}");
        }
    }
}

/// S0 acceptance: a perfect channel must lose nothing, for every palette and cell size.
#[test]
fn s0_perfect_channel_is_lossless() {
    let ideal = Channel::ideal();
    for pal in [&P2, &P4, &P8] {
        for cell in [6usize, 8, 10, 14, 20] {
            for seed in 0..8u32 {
                let (sent, got, ser) = roundtrip(pal, cell, &ideal, seed * 7 + cell as u32);
                assert_eq!(ser, 0.0, "{} cell={cell} seed={seed}", pal.name);
                assert_eq!(sent, got, "{} cell={cell} seed={seed}", pal.name);
            }
        }
    }
}

/// A good camera must be lossless at the fast profile.
#[test]
fn s1_good_camera_is_lossless_at_p8_8px() {
    let (sent, got, ser) = roundtrip(&P8, 8, &Channel::good(), 0xA11CE);
    assert_eq!(ser, 0.0);
    assert_eq!(sent, got);
}

/// ADR-0011, binding: the potato camera must have at least one clean layer,
/// and it must carry meaningfully more than the bulletproof floor.
#[test]
fn s1_potato_camera_has_a_surviving_layer() {
    let potato = Channel::potato();
    let mut best = 0usize;
    for pal in [&P2, &P4, &P8] {
        for cell in [6usize, 8, 10, 14, 20] {
            let (_, _, ser) = roundtrip(pal, cell, &potato, 0xF00D + cell as u32);
            if ser == 0.0 {
                let cap = FrameSpec::new(1920, 1080, cell).capacity_bytes(pal);
                best = best.max(cap);
            }
        }
    }
    assert!(best > 0, "no layer survives the potato camera");
    assert!(
        best >= 2000,
        "potato throughput floor too low: {best} B/frame"
    );
}

/// Degradation must be monotone in channel quality: a better camera is never worse.
#[test]
fn s1_better_camera_is_never_worse() {
    for pal in [&P4, &P8] {
        for cell in [8usize, 10, 14] {
            let ideal = roundtrip(pal, cell, &Channel::ideal(), 1).2;
            let good = roundtrip(pal, cell, &Channel::good(), 1).2;
            let webcam = roundtrip(pal, cell, &Channel::webcam(), 1).2;
            assert!(
                ideal <= good,
                "{} cell={cell}: ideal {ideal} > good {good}",
                pal.name
            );
            assert!(
                good <= webcam,
                "{} cell={cell}: good {good} > webcam {webcam}",
                pal.name
            );
        }
    }
}
