//! S4 — geometry. Can we recover the cell grid from a hand-held, off-axis camera?
//!
//! Pipeline under test:
//!   render -> stamp_fiducials -> [ warp + lens + all of S1's degradations ]
//!          -> rectify -> sample
//!
//! Artifacts: artifacts/s4-warped.png, artifacts/s4-rectified.png,
//!            artifacts/s4-frontier.csv

use optical_core::geometry;
use optical_core::sim::Channel;
use optical_core::{codec, modem, FrameSpec, Palette, P2, P4, P8};

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

struct Shot {
    spec: FrameSpec,
    sent: Vec<u8>,
    frame: optical_core::RgbImage,
}

/// One rendered, fiducial-stamped frame full of pseudorandom payload.
fn shoot(pal: &Palette, cell: usize, seed: u32) -> Shot {
    let spec = geometry::frame_spec(W, H, cell);
    let data = prng_bytes(spec.capacity_bytes(pal), seed);
    let sent = codec::bytes_to_symbols(&data, pal.bits);
    let mut frame = modem::render(&sent, &spec, pal);
    assert!(geometry::stamp_fiducials(&mut frame, &spec));
    Shot { spec, sent, frame }
}

/// Full trip through the channel and back. Returns (SER, detection RMS px).
/// SER of 1.0 with `None` RMS means the fiducials were never found.
fn trip(pal: &Palette, cell: usize, ch: &Channel, seed: u32) -> (f64, Option<f64>) {
    let s = shoot(pal, cell, seed);
    let seen = ch.apply(&s.frame);
    let truth = geometry::marker_centers(&s.spec).unwrap();
    let expect = truth.map(|p| ch.project_point(W, H, p));
    let rms = geometry::detect_fiducials(&seen, &s.spec).map(|d| geometry::rms_error(&d, &expect));
    match geometry::rectify(&seen, &s.spec) {
        Some(rect) => (
            modem::symbol_error_rate(&s.sent, &modem::sample(&rect, &s.spec, pal)),
            rms,
        ),
        None => (1.0, rms),
    }
}

fn fmt_ser(ser: f64) -> String {
    if ser == 0.0 {
        "      0".into()
    } else if ser >= 1.0 {
        "   LOST".into()
    } else {
        format!("{:>7.1e}", ser)
    }
}

/// Largest `scale` that still keeps all four canonical frame corners inside the
/// sensor frame at this pose. Scaling is linear about the image centre, so one
/// projection at scale 1.0 gives the answer directly.
///
/// This is the physical framing limit: "hold the screen so it just fills the
/// camera frame". It is not a decoder property, and it is what actually caps
/// how far a hand-held camera can be rotated.
fn fit_scale(yaw: f32, pitch: f32, roll: f32) -> f32 {
    let probe = Channel::ideal().with_geometry(yaw, pitch, roll, 1.0, 0.0, 0.0, 0.0);
    let h = probe.forward_homography(W, H);
    let (cx, cy) = (W as f64 / 2.0, H as f64 / 2.0);
    let mut s = f64::MAX;
    for corner in [
        [0.0, 0.0],
        [W as f64, 0.0],
        [W as f64, H as f64],
        [0.0, H as f64],
    ] {
        let p = h.apply(corner);
        let (dx, dy) = ((p[0] - cx).abs(), (p[1] - cy).abs());
        if dx > 1e-9 {
            s = s.min(cx / dx);
        }
        if dy > 1e-9 {
            s = s.min(cy / dy);
        }
    }
    (s * 0.97) as f32
}

/// (palette name, cell px, bytes per frame) of a clean-decoding layer.
type Layer = (&'static str, usize, usize);

/// Best clean layer (highest B/frame with SER = 0) under one channel.
fn best_layer(ch: &Channel, seed: u32) -> Option<Layer> {
    let mut best: Option<Layer> = None;
    for pal in [&P2, &P4, &P8] {
        for cell in [8usize, 10, 14, 20, 28, 40] {
            let cap = geometry::frame_spec(W, H, cell).capacity_bytes(pal);
            if best.is_some_and(|(_, _, b)| cap <= b) {
                continue;
            }
            if trip(pal, cell, ch, seed + cell as u32).0 == 0.0 {
                best = Some((pal.name, cell, cap));
            }
        }
    }
    best
}

fn main() {
    let _ = std::fs::create_dir_all("artifacts");
    let palettes: [&Palette; 3] = [&P2, &P4, &P8];
    let cells = [6usize, 8, 10, 14, 20];

    // ---------------------------------------------------------------- visuals
    let s = shoot(&P8, 10, 0x5417);
    let ch = Channel::webcam_handheld();
    let warped = ch.apply(&s.frame);
    warped.save_png("artifacts/s4-warped.png").expect("png");
    let rect = geometry::rectify(&warped, &s.spec).expect("rectify the reference capture");
    rect.save_png("artifacts/s4-rectified.png").expect("png");
    println!("artifact: artifacts/s4-warped.png  (webcam+warp capture, P8 @ 10px)");
    println!("artifact: artifacts/s4-rectified.png (same frame after rectify)\n");

    // ------------------------------------------------- fiducial accuracy table
    println!("Fiducial detection accuracy — RMS distance to the true projected centre");
    println!("  {:<14}{:>10}{:>12}", "camera", "rms px", "max px");
    for (name, ch) in Channel::named_handheld() {
        let s = shoot(&P8, 10, 0x11);
        let seen = ch.apply(&s.frame);
        let truth = geometry::marker_centers(&s.spec).unwrap();
        let expect = truth.map(|p| ch.project_point(W, H, p));
        match geometry::detect_fiducials(&seen, &s.spec) {
            Some(d) => {
                let worst = d
                    .iter()
                    .zip(expect.iter())
                    .map(|(p, q)| ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt())
                    .fold(0.0f64, f64::max);
                println!(
                    "  {:<14}{:>10.3}{:>12.3}",
                    name,
                    geometry::rms_error(&d, &expect),
                    worst
                );
            }
            None => println!("  {:<14}{:>10}{:>12}", name, "NOT FOUND", "-"),
        }
    }
    println!();

    // ------------------------------------------------------ decode vs warp angle
    // Every sweep frames the screen as large as that pose allows (fit_scale),
    // which is how a human aims a camera. Two layers are shown: P8 @ 20px is
    // resolution-proof, so a failure there is purely geometric; P8 @ 10px is
    // where geometry and sensor resolution start to fight each other.
    let base = Channel::webcam();
    println!(
        "Decode vs. warp, on top of Channel::webcam() (SER; 0 = clean, LOST = fiducials not found)"
    );

    println!("\n  in-plane rotation (roll), screen framed as large as the pose allows");
    let rolls = [
        -40.0f32, -30.0, -25.0, -20.0, -15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0,
        40.0,
    ];
    print!("    {:<10}", "deg");
    for r in rolls {
        print!("{:>8.0}", r);
    }
    println!();
    print!("    {:<10}", "fit scale");
    for r in rolls {
        print!("{:>8.2}", fit_scale(0.0, 0.0, r));
    }
    println!();
    for (label, pal, cell) in [("SER P8@20", &P8, 20usize), ("SER P8@10", &P8, 10usize)] {
        print!("    {:<10}", label);
        for r in rolls {
            let c = base.with_geometry(0.0, 0.0, r, fit_scale(0.0, 0.0, r), 0.0, 0.0, 0.0);
            print!("{:>8}", fmt_ser(trip(pal, cell, &c, 0x21).0).trim_start());
        }
        println!();
    }

    println!("\n  off-axis viewing (yaw, pitch held at half the yaw)");
    let yaws = [
        0.0f32, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0,
    ];
    print!("    {:<10}", "deg");
    for y in yaws {
        print!("{:>8.0}", y);
    }
    println!();
    print!("    {:<10}", "fit scale");
    for y in yaws {
        print!("{:>8.2}", fit_scale(y, y / 2.0, 0.0));
    }
    println!();
    for (label, pal, cell) in [("SER P8@20", &P8, 20usize), ("SER P8@10", &P8, 10usize)] {
        print!("    {:<10}", label);
        for y in yaws {
            let c = base.with_geometry(y, y / 2.0, 0.0, fit_scale(y, y / 2.0, 0.0), 0.0, 0.0, 0.0);
            print!("{:>8}", fmt_ser(trip(pal, cell, &c, 0x22).0).trim_start());
        }
        println!();
    }

    println!("\n  scale (screen size in the sensor frame), off-centre by +4%/-3%");
    let scales = [
        1.20f32, 1.10, 1.00, 0.95, 0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30,
    ];
    print!("    {:<10}", "scale");
    for s in scales {
        print!("{:>8.2}", s);
    }
    println!();
    for (label, pal, cell) in [("SER P8@20", &P8, 20usize), ("SER P8@10", &P8, 10usize)] {
        print!("    {:<10}", label);
        for s in scales {
            let c = base.with_geometry(0.0, 0.0, 0.0, s, 0.04, -0.03, 0.0);
            print!("{:>8}", fmt_ser(trip(pal, cell, &c, 0x23).0).trim_start());
        }
        println!();
    }

    println!("\n  barrel distortion (k < 0 = barrel; k is recovered from the frame, not assumed)");
    let barrels = [
        0.0f32, -0.02, -0.05, -0.08, -0.11, -0.14, -0.17, -0.20, -0.25,
    ];
    print!("    {:<10}", "k");
    for b in barrels {
        print!("{:>8.2}", b);
    }
    println!();
    for (label, pal, cell) in [("SER P8@20", &P8, 20usize), ("SER P8@10", &P8, 10usize)] {
        print!("    {:<10}", label);
        for b in barrels {
            let c = base.with_geometry(0.0, 0.0, 0.0, 0.75, 0.0, 0.0, b);
            print!("{:>8}", fmt_ser(trip(pal, cell, &c, 0x24).0).trim_start());
        }
        println!();
    }

    // ------------------------------------------------------- acceptance corners
    // ADR-0011 is layered: "decode survives X" means *some* layer decodes
    // cleanly under X, not that the fastest one does. Each case reports which.
    //
    // NOMINAL is the framing all cases start from. It has to be around half the
    // frame rather than ~0.95, because a 16:9 screen rotated 15 degrees needs
    // 1920 sin15 + 1080 cos15 = 1540 px of sensor height (fit_scale(15deg) =
    // 0.68), and the "+20% scale" and off-centre cases have to fit on top of
    // that. Framing, not the decoder, is what sets this.
    const NOMINAL: f32 = 0.52;
    println!(
        "\nS4 acceptance (Channel::webcam(); screen at {:.0}% of the sensor frame)",
        NOMINAL * 100.0
    );
    let cases: [(&str, Channel); 8] = [
        (
            "+15 deg roll",
            base.with_geometry(0.0, 0.0, 15.0, NOMINAL, 0.0, 0.0, 0.0),
        ),
        (
            "-15 deg roll",
            base.with_geometry(0.0, 0.0, -15.0, NOMINAL, 0.0, 0.0, 0.0),
        ),
        (
            "+20% scale",
            base.with_geometry(0.0, 0.0, 0.0, NOMINAL * 1.2, 0.0, 0.0, 0.0),
        ),
        (
            "-20% scale",
            base.with_geometry(0.0, 0.0, 0.0, NOMINAL * 0.8, 0.0, 0.0, 0.0),
        ),
        (
            "off-centre +8%/-6%",
            base.with_geometry(0.0, 0.0, 0.0, NOMINAL, 0.08, -0.06, 0.0),
        ),
        (
            "barrel k=-0.10",
            base.with_geometry(0.0, 0.0, 0.0, NOMINAL, 0.0, 0.0, -0.10),
        ),
        (
            "+15 roll, +20% scale, off-centre, barrel",
            base.with_geometry(0.0, 0.0, 15.0, NOMINAL * 1.2, 0.05, -0.04, -0.08),
        ),
        (
            "-15 roll, -20% scale, 15/8 off-axis, off-centre, barrel",
            base.with_geometry(15.0, 8.0, -15.0, NOMINAL * 0.8, -0.06, 0.05, -0.08),
        ),
    ];
    let mut acceptance_ok = true;
    for (name, c) in &cases {
        let best = best_layer(c, 0x31);
        acceptance_ok &= best.is_some();
        match best {
            Some((pal, cell, cap)) => println!(
                "  {:<56} clean at {:>3} @ {:>2}px = {:>6} B/frame  PASS",
                name, pal, cell, cap
            ),
            None => println!("  {:<56} {:>40}  FAIL", name, "no clean layer"),
        }
    }

    // ------------------------------------------------------ rolling-shutter tear
    println!("\nRolling-shutter tear (rows above the seam come from the previous frame)");
    let (pal, cell) = (&P8, 14usize);
    let a = shoot(pal, cell, 0x41);
    let b = shoot(pal, cell, 0x42);
    for at in [0.0f32, 0.25, 0.5, 0.75] {
        let c = Channel::webcam_handheld().with_tear(at);
        let seen = c.apply_pair(&b.frame, &a.frame);
        let found = geometry::detect_fiducials(&seen, &b.spec).is_some();
        let ser = geometry::rectify(&seen, &b.spec)
            .map(|r| modem::symbol_error_rate(&b.sent, &modem::sample(&r, &b.spec, pal)))
            .unwrap_or(1.0);
        println!(
            "  seam at {:>4.0}% of height: fiducials {:<9} SER {}",
            at * 100.0,
            if found { "found" } else { "NOT FOUND" },
            fmt_ser(ser).trim_start()
        );
    }

    // --------------------------------------------------------- revised frontier
    println!("\nClean-decode frontier WITH geometry (SER over palette x cell)\n");
    let mut csv =
        String::from("channel,palette,bits,cell_px,bytes_per_frame,ser,fiducial_rms_px\n");
    let mut frontier: Vec<(String, Option<Layer>)> = Vec::new();
    for (cname, ch) in Channel::named_handheld() {
        println!("  channel: {cname}");
        print!("    {:<8}", "cell px");
        for c in &cells {
            print!("{:>9}", c);
        }
        println!();
        let mut best: Option<Layer> = None;
        for pal in palettes {
            print!("    {:<8}", pal.name);
            for &cell in &cells {
                let (ser, rms) = trip(pal, cell, &ch, 0xC0DE + cell as u32);
                let cap = geometry::frame_spec(W, H, cell).capacity_bytes(pal);
                csv.push_str(&format!(
                    "{},{},{},{},{},{:.6e},{}\n",
                    cname,
                    pal.name,
                    pal.bits,
                    cell,
                    cap,
                    ser,
                    rms.map(|v| format!("{v:.3}")).unwrap_or("nan".into())
                ));
                if ser == 0.0 && best.is_none_or(|(_, _, b)| cap > b) {
                    best = Some((pal.name, cell, cap));
                }
                print!("{:>9}", fmt_ser(ser).trim_start());
            }
            println!();
        }
        frontier.push((cname.to_string(), best));
        println!();
    }

    std::fs::write("artifacts/s4-frontier.csv", &csv).expect("write csv");
    println!("artifact: artifacts/s4-frontier.csv\n");

    // Two no-warp baselines, both from a 1-cell margin and an aligned grid:
    //   S1 as published, and S1 as it stands today (re-run by `spike1` after
    //   S2 inserted the 2-row header band, which re-phased the cell grid).
    let s1: [(&str, &str, usize, &str, usize); 3] = [
        ("good+warp", "P8 @ 6px", 21_405, "P8 @ 6px", 20_868),
        ("webcam+warp", "P8 @ 8px", 11_781, "P8 @ 8px", 11_602),
        ("potato+warp", "P2 @ 8px", 3_927, "P8 @ 14px", 3_645),
    ];
    println!("Revised clean-decode frontier — what geometry costs");
    println!(
        "  {:<13}{:>12}{:>9}{:>12}{:>9}{:>12}{:>9}{:>8}",
        "camera", "S1 pub", "B/fr", "S1 today", "B/fr", "S4 warp", "B/fr", "vs S1"
    );
    for (name, best) in &frontier {
        let (_, pub_l, pub_c, now_l, now_c) = s1.iter().find(|(n, ..)| n == name).copied().unwrap();
        match best {
            Some((pal, cell, cap)) => println!(
                "  {:<13}{:>12}{:>9}{:>12}{:>9}{:>12}{:>9}{:>7.1}%",
                name,
                pub_l,
                pub_c,
                now_l,
                now_c,
                format!("{pal} @ {cell}px"),
                cap,
                100.0 * (*cap as f64 - pub_c as f64) / pub_c as f64
            ),
            None => println!(
                "  {:<13}{:>12}{:>9}{:>12}{:>9}{:>12}{:>9}{:>8}",
                name, pub_l, pub_c, now_l, now_c, "NONE", 0, "-100%"
            ),
        }
    }

    // ADR-0011 is binding: the potato must still complete, warp or no warp.
    let potato = frontier
        .iter()
        .find(|(n, _)| n == "potato+warp")
        .and_then(|(_, b)| *b);
    match potato {
        Some((pal, cell, cap)) => println!(
            "\nADR-0011 potato check WITH warp: PASS — best surviving layer {pal} @ {cell}px ({cap} B/frame)"
        ),
        None => {
            eprintln!("\nADR-0011 potato check WITH warp: FAIL — no layer survives the warped potato");
            std::process::exit(1);
        }
    }

    if !acceptance_ok {
        eprintln!("\nS4 acceptance: FAIL");
        std::process::exit(1);
    }
    println!("S4 acceptance: PASS");
}
