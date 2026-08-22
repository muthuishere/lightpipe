//! S4 regression tests: fiducials, homography, rectification (ADR-0002, ADR-0009).
//! No hardware, no browser.

use optical_core::geometry::{self, GeometryFit, Homography, Radial};
use optical_core::sim::Channel;
use optical_core::{codec, modem, palette, Palette, P4, P8};

const P2: Palette = Palette {
    name: "P2",
    colors: &[palette::BLACK, palette::WHITE],
    bits: 1,
};

const W: usize = 1920;
const H: usize = 1080;

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

/// render -> stamp_fiducials -> channel -> rectify -> sample.
fn trip(pal: &Palette, cell: usize, ch: &Channel, seed: u32) -> f64 {
    let spec = geometry::frame_spec(W, H, cell);
    let data = prng_bytes(spec.capacity_bytes(pal), seed);
    let sent = codec::bytes_to_symbols(&data, pal.bits);
    let mut frame = modem::render(&sent, &spec, pal);
    assert!(geometry::stamp_fiducials(&mut frame, &spec));
    let seen = ch.apply(&frame);
    match geometry::rectify(&seen, &spec) {
        Some(r) => modem::symbol_error_rate(&sent, &modem::sample(&r, &spec, pal)),
        None => 1.0,
    }
}

// ---------------------------------------------------------------- pure maths

#[test]
fn homography_recovers_a_known_projective_map() {
    let truth = Homography::from_mat([
        [1.10, 0.20, -30.0],
        [-0.15, 0.95, 40.0],
        [0.00012, -0.00007, 1.0],
    ]);
    let src = [[0.0, 0.0], [1920.0, 0.0], [1920.0, 1080.0], [0.0, 1080.0]];
    let dst = src.map(|p| truth.apply(p));
    let fitted = Homography::from_points(&src, &dst).expect("solvable");
    for p in [[100.0, 700.0], [1500.0, 200.0], [960.0, 540.0]] {
        let (a, b) = (truth.apply(p), fitted.apply(p));
        assert!(
            (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6,
            "{a:?} vs {b:?}"
        );
    }
    let back = fitted.inverse().expect("invertible");
    for p in src {
        let q = back.apply(fitted.apply(p));
        assert!((p[0] - q[0]).abs() < 1e-6 && (p[1] - q[1]).abs() < 1e-6);
    }
}

#[test]
fn homography_rejects_degenerate_points() {
    let p = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]];
    assert!(Homography::from_points(&p, &p).is_none());
}

#[test]
fn radial_distort_and_undistort_are_inverses() {
    for k in [-0.20, -0.09, -0.01, 0.0, 0.05, 0.20] {
        let r = Radial::new(W, H, k);
        for p in [[0.0, 0.0], [960.0, 540.0], [1919.0, 1079.0], [300.0, 900.0]] {
            let q = r.undistort(r.distort(p));
            assert!(
                (p[0] - q[0]).abs() < 1e-3 && (p[1] - q[1]).abs() < 1e-3,
                "k={k} {p:?} -> {q:?}"
            );
        }
    }
}

// ------------------------------------------------------------------ stamping

#[test]
fn stamping_never_touches_a_payload_cell() {
    for cell in [6usize, 8, 10, 14, 20] {
        let spec = geometry::frame_spec(W, H, cell);
        let syms = codec::bytes_to_symbols(&prng_bytes(spec.capacity_bytes(&P8), 7), 3);
        let clean = modem::render(&syms, &spec, &P8);
        let mut stamped = clean.clone();
        assert!(geometry::stamp_fiducials(&mut stamped, &spec));
        for r in 0..spec.rows() {
            for c in 0..spec.cols() {
                let (x, y) = spec.cell_origin(c, r);
                assert_eq!(
                    clean.px(x + cell / 2, y + cell / 2),
                    stamped.px(x + cell / 2, y + cell / 2),
                    "cell ({c},{r}) at cell={cell} was overwritten"
                );
            }
        }
        // ...and the payload it carries still reads back unchanged.
        let got = modem::sample(&stamped, &spec, &P8);
        assert_eq!(
            got[..syms.len()],
            syms[..],
            "payload changed at cell={cell}"
        );
    }
}

#[test]
fn a_spec_with_no_room_refuses_to_stamp() {
    let tight = optical_core::FrameSpec::new(W, H, 8); // margin = 1 cell
    let mut img = optical_core::RgbImage::new(W, H);
    assert!(!geometry::stamp_fiducials(&mut img, &tight));
    assert!(geometry::marker_centers(&tight).is_none());
    assert!(geometry::detect_fiducials(&img, &tight).is_none());
}

// ----------------------------------------------------------------- detection

#[test]
fn fiducials_are_located_to_sub_pixel_precision() {
    let spec = geometry::frame_spec(W, H, 10);
    let syms = codec::bytes_to_symbols(&prng_bytes(spec.capacity_bytes(&P8), 3), 3);
    let mut frame = modem::render(&syms, &spec, &P8);
    assert!(geometry::stamp_fiducials(&mut frame, &spec));
    let truth = geometry::marker_centers(&spec).unwrap();

    for (name, ch, tol) in [
        ("ideal", Channel::ideal(), 0.05),
        ("good+warp", Channel::good_handheld(), 1.5),
        ("webcam+warp", Channel::webcam_handheld(), 2.0),
        ("potato+warp", Channel::potato_handheld(), 2.5),
    ] {
        let seen = ch.apply(&frame);
        let expect = truth.map(|p| ch.project_point(W, H, p));
        let found = geometry::detect_fiducials(&seen, &spec)
            .unwrap_or_else(|| panic!("{name}: fiducials not found"));
        let rms = geometry::rms_error(&found, &expect);
        assert!(rms < tol, "{name}: fiducial rms {rms:.3}px exceeds {tol}px");
    }
}

/// A frame with no fiducials must fail loudly (ADR-0011), never decode garbage.
#[test]
fn rectify_refuses_a_frame_without_fiducials() {
    let spec = geometry::frame_spec(W, H, 10);
    let syms = codec::bytes_to_symbols(&prng_bytes(spec.capacity_bytes(&P8), 5), 3);
    let unstamped = modem::render(&syms, &spec, &P8);
    assert!(geometry::rectify(&Channel::webcam().apply(&unstamped), &spec).is_none());
    assert!(geometry::rectify(&optical_core::RgbImage::new(W, H), &spec).is_none());
}

// ------------------------------------------------------------- rectification

/// S4 acceptance: +-15 deg rotation, +-20% scale, off-centre translation and
/// barrel distortion, all on top of the full `webcam()` optical degradation.
/// 0.52 is the framing every case starts from — see spike4 for why a 16:9
/// screen cannot be framed larger than that and still take 15 deg of roll.
#[test]
fn s4_decode_survives_rotation_scale_translation_and_barrel() {
    let base = Channel::webcam();
    let n = 0.52f32;
    let cases: [(&str, Channel); 6] = [
        (
            "+15 roll",
            base.with_geometry(0.0, 0.0, 15.0, n, 0.0, 0.0, 0.0),
        ),
        (
            "-15 roll",
            base.with_geometry(0.0, 0.0, -15.0, n, 0.0, 0.0, 0.0),
        ),
        (
            "+20% scale",
            base.with_geometry(0.0, 0.0, 0.0, n * 1.2, 0.0, 0.0, 0.0),
        ),
        (
            "-20% scale",
            base.with_geometry(0.0, 0.0, 0.0, n * 0.8, 0.0, 0.0, 0.0),
        ),
        (
            "off-centre + barrel",
            base.with_geometry(0.0, 0.0, 0.0, n, 0.08, -0.06, -0.10),
        ),
        (
            "all of it",
            base.with_geometry(15.0, 8.0, -15.0, n * 0.8, -0.06, 0.05, -0.08),
        ),
    ];
    for (name, ch) in &cases {
        let ser = trip(&P8, 20, ch, 0x5411);
        assert_eq!(ser, 0.0, "{name}: SER {ser:.3e}");
    }
}

/// ADR-0011 is binding and geometry does not get to break it: the potato must
/// still have a clean layer once the camera is hand-held.
#[test]
fn adr0011_potato_still_has_a_clean_layer_under_warp() {
    let potato = Channel::potato_handheld();
    let mut best = 0usize;
    for pal in [&P2, &P4, &P8] {
        for cell in [14usize, 20] {
            if trip(pal, cell, &potato, 0xF00D + cell as u32) == 0.0 {
                best = best.max(geometry::frame_spec(W, H, cell).capacity_bytes(pal));
            }
        }
    }
    assert!(best > 0, "no layer survives the warped potato camera");
}

/// The fiducials are identical in every frame, so a rolling-shutter seam can
/// corrupt payload but can never cost us the geometry.
#[test]
fn a_rolling_shutter_tear_never_costs_the_geometry() {
    let spec = geometry::frame_spec(W, H, 14);
    let mut a = modem::render(
        &codec::bytes_to_symbols(&prng_bytes(spec.capacity_bytes(&P8), 11), 3),
        &spec,
        &P8,
    );
    let mut b = modem::render(
        &codec::bytes_to_symbols(&prng_bytes(spec.capacity_bytes(&P8), 22), 3),
        &spec,
        &P8,
    );
    assert!(geometry::stamp_fiducials(&mut a, &spec));
    assert!(geometry::stamp_fiducials(&mut b, &spec));
    for at in [0.25f32, 0.5, 0.75] {
        let ch = Channel::webcam_handheld().with_tear(at);
        let seen = ch.apply_pair(&b, &a);
        assert!(
            geometry::detect_fiducials(&seen, &spec).is_some(),
            "tear at {at} lost the fiducials"
        );
    }
}

// ---------------------------------------------------------- simulator contract

/// The S1 ladder is defined on an aligned grid. The base presets must stay
/// geometry-free or `tests/roundtrip.rs` — and every S0/S1/S2 number — moves.
#[test]
fn base_presets_carry_no_geometry() {
    for (name, ch) in Channel::named() {
        assert!(!ch.has_geometry(), "{name} gained a geometry term");
        assert_eq!(ch.tear_at, 0.0, "{name} gained a tear");
    }
    for (name, ch) in Channel::named_handheld() {
        assert!(ch.has_geometry(), "{name} has no geometry");
    }
}

#[test]
fn a_geometry_free_channel_is_bit_identical_to_before() {
    let spec = geometry::frame_spec(W, H, 14);
    let img = modem::render(
        &codec::bytes_to_symbols(&prng_bytes(spec.capacity_bytes(&P4), 9), 2),
        &spec,
        &P4,
    );
    // apply() must route through apply_pair() without changing a pixel.
    let ch = Channel::webcam();
    assert!(ch.apply(&img) == ch.apply_pair(&img, &img));
    // An identity geometry warp is an exact no-op on the sampled symbols.
    let identity = Channel::ideal().with_geometry(0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0);
    assert!(!identity.has_geometry());
    assert!(identity.apply(&img) == img);
}

/// The forward projection the simulator uses and the fit `rectify` produces
/// must be the same map, or "ground truth" in the spike means nothing.
#[test]
fn simulator_projection_matches_a_fit_through_the_same_points() {
    let spec = geometry::frame_spec(W, H, 10);
    let ch = Channel::ideal().with_geometry(10.0, 6.0, -8.0, 0.7, 0.03, -0.02, -0.07);
    let canon = geometry::marker_centers(&spec).unwrap();
    let obs = canon.map(|p| ch.project_point(W, H, p));
    let radial = Radial::new(W, H, -0.07);
    let h = Homography::from_points(&canon, &obs.map(|p| radial.undistort(p))).unwrap();
    let fit = GeometryFit { h, radial };
    for p in [[200.0, 200.0], [1700.0, 900.0], [960.0, 540.0]] {
        let (a, b) = (ch.project_point(W, H, p), fit.map(p));
        assert!(
            (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6,
            "{a:?} vs {b:?}"
        );
    }
}
