//! Native twin of `harness/run.mjs`: the identical [`optical_wasm::engine`] code
//! path, with no JS and no wasm. Subtract this from the Node numbers and what is
//! left is the boundary plus the wasm codegen gap — which is the only way to say
//! anything honest about "what does the JS<->WASM crossing cost us" (ADR-0007
//! rejected Go over exactly this, on an unmeasured claim).
//!
//! Usage: `bench_native [frames] [width] [height] [profile]`

use optical_wasm::engine::{Profile, Receiver, Sender};
use std::time::Instant;

fn payload(n: usize, seed: u32) -> Vec<u8> {
    // Same generator as harness/run.mjs, so both sides move identical bytes.
    let words: [&str; 12] = [
        "the", "optical", "channel", "is", "light", "not", "a", "network", "fountain", "chunk",
        "gzip", "blake3",
    ];
    let mut x = seed | 1;
    let mut out = Vec::with_capacity(n + 32);
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        out.extend_from_slice(words[(x as usize >> 7) % words.len()].as_bytes());
        out.push(if x.is_multiple_of(11) { b'\n' } else { b' ' });
    }
    out.truncate(n);
    out
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let frames: usize = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(60);
    let w: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(1920);
    let h: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1080);
    let profile = Profile::parse(a.get(4).map(|s| s.as_str()).unwrap_or("auto")).unwrap();

    let cap = optical_wasm::engine::frame_capacity(profile, w, h);
    let data = payload(cap * frames + 1000, 7);

    let mut tx = Sender::create(data.clone(), profile, 262_144, w, h).expect("sender");
    tx.set_stamp_fiducials(true);
    let mut rx = Receiver::create(profile, w, h).expect("receiver");
    rx.set_geometry(false);

    // Warm up: one frame each, so allocation and first-touch costs are excluded.
    let f = tx.next_frame().expect("frame");
    let src = unsafe { std::slice::from_raw_parts(f.ptr, f.len) }.to_vec();
    rx.frame_slice_mut().copy_from_slice(&src);
    rx.push_frame();

    let mut enc_ns = 0u128;
    let mut dec_ns = 0u128;
    let mut copy_ns = 0u128;
    let mut accepted = 0usize;
    for _ in 0..frames {
        let t0 = Instant::now();
        let f = tx.next_frame().expect("frame");
        enc_ns += t0.elapsed().as_nanos();
        let src = unsafe { std::slice::from_raw_parts(f.ptr, f.len) }.to_vec();

        let t1 = Instant::now();
        rx.frame_slice_mut().copy_from_slice(&src);
        copy_ns += t1.elapsed().as_nanos();

        let t2 = Instant::now();
        let r = rx.push_frame();
        dec_ns += t2.elapsed().as_nanos();
        accepted += r.accepted as usize;
        if std::env::var("DBG").is_ok() {
            println!(
                "  f: acc={} reason={:?} cc={:?} need={} q={:.3}",
                r.accepted, r.reason, r.chunk_complete, r.needed_more, r.quality
            );
        }
    }

    let ms = |ns: u128| ns as f64 / 1e6 / frames as f64;
    println!("native  {w}x{h} profile={} frames={frames}", profile.name());
    println!("  capacity      {cap} B/frame");
    println!(
        "  encode        {:.3} ms/frame  ({:.1} FPS)",
        ms(enc_ns),
        1000.0 / ms(enc_ns)
    );
    println!("  frame copy    {:.3} ms/frame", ms(copy_ns));
    println!(
        "  decode        {:.3} ms/frame  ({:.1} FPS)",
        ms(dec_ns),
        1000.0 / ms(dec_ns)
    );
    println!("  accepted      {accepted}/{frames}");

    // Where the rectification path actually spends its time. This is the number
    // that decides whether a hand-held camera can be decoded at frame rate.
    use optical_core::geometry;
    use optical_core::header;
    use optical_core::image::RgbImage;
    let f = tx.next_frame().expect("frame");
    let rgba = unsafe { std::slice::from_raw_parts(f.ptr, f.len) };
    let mut img = RgbImage::new(w, h);
    for i in 0..w * h {
        img.data[i * 3] = rgba[i * 4];
        img.data[i * 3 + 1] = rgba[i * 4 + 1];
        img.data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    let spec = geometry::frame_spec(w, h, profile.cell());
    let reps = 3;
    let t = Instant::now();
    for _ in 0..reps {
        let _ = geometry::detect_fiducials(&img, &spec);
    }
    let detect = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    let t = Instant::now();
    let mut fit = None;
    for _ in 0..reps {
        fit = geometry::fit_geometry(&img, &spec);
    }
    let full_fit = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    let fit = fit.expect("geometry fit");
    let t = Instant::now();
    let mut warped = RgbImage::new(w, h);
    for _ in 0..reps {
        warped = geometry::warp_with(&img, &spec, &fit);
    }
    let warp = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    let t = Instant::now();
    for _ in 0..reps {
        let _ = header::decode_frame(&warped, &spec, profile.palette());
    }
    let dec = t.elapsed().as_secs_f64() * 1000.0 / reps as f64;
    println!("  -- rectification path --");
    println!("    detect_fiducials  {detect:.1} ms");
    // K_STAGES in geometry.rs is 3 coarse-to-fine stages = 41+21+16 = 78 grid_score
    // evaluations, each sampling every 3rd cell with 9 bilinear taps.
    println!("    fit_geometry      {full_fit:.1} ms  (detect + ~78 grid_score evaluations)");
    println!("    warp_with         {warp:.1} ms");
    println!("    decode_frame      {dec:.1} ms");
    println!(
        "    total             {:.1} ms  = {:.2} FPS",
        full_fit + warp + dec,
        1000.0 / (full_fit + warp + dec)
    );
}
