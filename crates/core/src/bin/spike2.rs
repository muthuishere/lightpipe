//! S2 — frame integrity: header band + CRC32.
//! Proves a corrupt frame is never silently accepted (ADR-0004).
//! Artifact: artifacts/s2-integrity.txt

use optical_core::codec;
use optical_core::header::{self, FrameHeader};
use optical_core::sim::Channel;
use optical_core::{FrameSpec, Palette, P4, P8};
use std::fmt::Write as _;

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
}

/// Every (palette, cell) the S1 sweep reports as SER 0 for that camera.
const WEBCAM_CLEAN: &[(&Palette, usize)] = &[
    (&P4, 8),
    (&P4, 10),
    (&P4, 14),
    (&P8, 8),
    (&P8, 10),
    (&P8, 14),
];
const POTATO_CLEAN: &[(&Palette, usize)] = &[(&P4, 14), (&P4, 20), (&P8, 14), (&P8, 20)];

fn main() {
    let mut out = String::new();
    let mut ok = true;
    macro_rules! say {
        ($($a:tt)*) => {{ println!($($a)*); let _ = writeln!(out, $($a)*); }};
    }

    say!("S2 — frame integrity: header band + CRC32\n");
    say!(
        "header record: {} B  (magic u16 · version u8 · seq u32 · payload_len u16 · oti[12] · crc32)",
        header::HEADER_BYTES
    );
    say!(
        "band: {} grid rows between the calibration strip and the payload; the record is",
        FrameSpec::HEADER_ROWS
    );
    say!("repeated across it and the first copy whose CRC validates wins.\n");

    // ---- 1. capacity + overhead ------------------------------------------------
    say!("1. capacity and header overhead (1920x1080)");
    say!(
        "   {:<4} {:>5}  {:>6} {:>6}  {:>9} {:>9}  {:>6}  {:>7}",
        "pal",
        "cell",
        "cols",
        "rows",
        "payload B",
        "band B",
        "copies",
        "overhead"
    );
    for pal in [&P4, &P8] {
        for cell in [8usize, 10, 14] {
            let spec = FrameSpec::new(1920, 1080, cell);
            let cap = spec.capacity_bytes(pal);
            let band = header::header_overhead_bytes(&spec, pal);
            let copies = header::header_copies(&spec, pal);
            say!(
                "   {:<4} {:>5}  {:>6} {:>6}  {:>9} {:>9}  {:>6}  {:>6.2}%",
                pal.name,
                cell,
                spec.cols(),
                spec.rows(),
                cap,
                band,
                copies,
                100.0 * band as f64 / (cap + band) as f64
            );
        }
    }
    say!("");

    // ---- 2. clean round-trip ---------------------------------------------------
    say!("2. clean frames round-trip exactly (ideal channel)");
    let ideal = Channel::ideal();
    let mut rng = Rng(0x5EED_C0FF_EE12_3456);
    for pal in [&P4, &P8] {
        for cell in [8usize, 10, 14] {
            let spec = FrameSpec::new(1920, 1080, cell);
            let cap = spec.capacity_bytes(pal);
            let payload = rng.bytes(cap);
            let mut oti = [0u8; 12];
            oti.copy_from_slice(&rng.bytes(12));
            let h = FrameHeader::new(0xDEAD_BEEF, cap as u16, oti);
            let img = header::encode_frame(&h, &payload, &spec, pal).expect("encode");
            let got = header::decode_frame(&ideal.apply(&img), &spec, pal);
            let good = got.as_ref().is_some_and(|d| {
                d.payload == payload && d.header.seq == 0xDEAD_BEEF && d.header.oti == oti
            });
            ok &= good;
            say!(
                "   {:<4} cell={:>2}px  {:>6} B  {}",
                pal.name,
                cell,
                cap,
                if good { "OK" } else { "FAIL" }
            );
        }
    }
    say!("");

    // ---- 3. false-accept rate over corrupted frames ----------------------------
    // Corruption is applied in symbol space — that is exactly what the optical
    // channel delivers to the decoder — so 100k trials run in seconds.
    say!("3. false-accept rate over corrupted frames");
    let specs: Vec<(&Palette, FrameSpec, &str)> = vec![
        (&P4, FrameSpec::new(960, 540, 8), "P4 960x540 c8"),
        (&P8, FrameSpec::new(960, 540, 8), "P8 960x540 c8"),
        (&P4, FrameSpec::new(1280, 720, 10), "P4 1280x720 c10"),
        (&P8, FrameSpec::new(640, 360, 14), "P8 640x360 c14"),
    ];
    const TRIALS: usize = 100_000;
    let per = TRIALS / specs.len();
    let mut false_accepts = 0usize;
    let mut accepted_correct = 0usize;
    let mut rejected = 0usize;
    let mut total = 0usize;

    for (pal, spec, name) in &specs {
        let cap = spec.capacity_bytes(pal);
        let copies = header::header_copies(spec, pal);
        let mut fa = 0usize;
        let mut acc = 0usize;
        for t in 0..per {
            let plen = 1 + rng.below(cap);
            let payload = rng.bytes(plen);
            let mut oti = [0u8; 12];
            oti.copy_from_slice(&rng.bytes(12));
            let h = FrameHeader::new(t as u32, plen as u16, oti);
            let (hdr, pay) = header::encode_symbols(&h, &payload, spec, pal).expect("encode");

            // Flip between 1 symbol and 30% of all cells, uniformly at random.
            let cells = hdr.len() + pay.len();
            let max_flips = (cells as f64 * 0.30) as usize;
            let flips = 1 + rng.below(max_flips.max(1));
            let (mut hdr, mut pay) = (hdr, pay);
            for _ in 0..flips {
                let i = rng.below(cells);
                let cur = if i < hdr.len() {
                    hdr[i]
                } else {
                    pay[i - hdr.len()]
                };
                // A real symbol error lands on a *different* symbol.
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
            match header::decode_symbols(&hdr, &pay, spec, pal) {
                None => rejected += 1,
                Some(d) => {
                    acc += 1;
                    if d.payload == payload && d.header == h {
                        accepted_correct += 1;
                    } else {
                        fa += 1;
                    }
                }
            }
        }
        false_accepts += fa;
        say!(
            "   {:<18} copies={} payload<={:>5}B  trials={:>6}  accepted(correct)={:>5}  FALSE ACCEPTS={}",
            name, copies, cap, per, acc - fa, fa
        );
    }
    ok &= false_accepts == 0;
    say!(
        "   ---- {} corrupted frames: {} rejected, {} accepted with byte-identical data,",
        total,
        rejected,
        accepted_correct
    );
    say!(
        "        FALSE-ACCEPT RATE = {} / {} = {:.3e}   {}",
        false_accepts,
        total,
        false_accepts as f64 / total as f64,
        if false_accepts == 0 { "OK" } else { "FAIL" }
    );
    say!("   (an accepted corrupt frame is only possible when the corruption fell");
    say!("    entirely outside the CRC-covered bytes, i.e. in the padding tail.)\n");

    // ---- 3b. same thing through the pixel path --------------------------------
    say!("3b. pixel-level corruption (cells repainted in the rendered image)");
    let spec = FrameSpec::new(960, 540, 8);
    let mut fa_px = 0usize;
    let mut acc_px = 0usize;
    const PX_TRIALS: usize = 1_000;
    for t in 0..PX_TRIALS {
        let pal: &Palette = if t % 2 == 0 { &P4 } else { &P8 };
        let cap = spec.capacity_bytes(pal);
        let plen = 1 + rng.below(cap);
        let payload = rng.bytes(plen);
        let mut oti = [0u8; 12];
        oti.copy_from_slice(&rng.bytes(12));
        let h = FrameHeader::new(t as u32, plen as u16, oti);
        let mut img = header::encode_frame(&h, &payload, &spec, pal).expect("encode");

        let cells = spec.header_cells() + spec.payload_cells();
        let flips = 1 + rng.below(((cells as f64 * 0.30) as usize).max(1));
        for _ in 0..flips {
            let i = rng.below(cells);
            let (col, row) = if i < spec.header_cells() {
                (i % spec.cols(), spec.header_row0() + i / spec.cols())
            } else {
                let j = i - spec.header_cells();
                (j % spec.cols(), spec.payload_row0() + j / spec.cols())
            };
            let (x, y) = spec.cell_origin(col, row);
            let v = rng.below(pal.len()) as u8;
            img.fill_rect(x, y, spec.cell, spec.cell, pal.color(v));
        }
        if let Some(d) = header::decode_frame(&img, &spec, pal) {
            acc_px += 1;
            if d.payload != payload || d.header != h {
                fa_px += 1;
            }
        }
    }
    ok &= fa_px == 0;
    say!(
        "   {} corrupted rendered frames: {} accepted (all byte-identical), FALSE ACCEPTS={}  {}",
        PX_TRIALS,
        acc_px,
        fa_px,
        if fa_px == 0 { "OK" } else { "FAIL" }
    );
    say!("");

    // ---- 4. header survives the simulated cameras ------------------------------
    say!("4. header decodes under the simulated cameras, at the S1-clean layers");
    for (cam, ch, layers) in [
        ("webcam", Channel::webcam(), WEBCAM_CLEAN),
        ("potato", Channel::potato(), POTATO_CLEAN),
    ] {
        for (pal, cell) in layers {
            let spec = FrameSpec::new(1920, 1080, *cell);
            let cap = spec.capacity_bytes(pal);
            let payload = rng.bytes(cap);
            let mut oti = [0u8; 12];
            oti.copy_from_slice(&rng.bytes(12));
            let h = FrameHeader::new(7, cap as u16, oti);
            let img = header::encode_frame(&h, &payload, &spec, pal).expect("encode");
            let got = header::decode_frame(&ch.apply(&img), &spec, pal);
            let good = got.as_ref().is_some_and(|d| d.payload == payload);
            ok &= good;
            say!(
                "   {:<7} {:<4} cell={:>2}px  {:>6} B/frame  copies={}  {}",
                cam,
                pal.name,
                cell,
                cap,
                header::header_copies(&spec, pal),
                if good { "OK" } else { "FAIL" }
            );
        }
    }
    say!("");
    say!(
        "symbols per header copy: P4={} P8={}",
        codec::symbols_for_bytes(header::HEADER_BYTES, P4.bits),
        codec::symbols_for_bytes(header::HEADER_BYTES, P8.bits)
    );
    say!("\n{}", if ok { "S2 PASS" } else { "S2 FAILED" });

    let _ = std::fs::create_dir_all("artifacts");
    std::fs::write("artifacts/s2-integrity.txt", &out).expect("write artifact");
    println!("\nartifact: artifacts/s2-integrity.txt");
    if !ok {
        std::process::exit(1);
    }
}
