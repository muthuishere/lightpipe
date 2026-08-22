//! S1 — degraded-channel sweep. Emits the symbol-error-rate surface that
//! becomes the rate ladder of ADR-0011.
//! Artifact: artifacts/s1-sweep.csv

use optical_core::codec;
use optical_core::modem;
use optical_core::sim::Channel;
use optical_core::{FrameSpec, Palette, P2, P4, P8};

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

fn trial(pal: &Palette, cell: usize, ch: &Channel) -> (f64, usize) {
    let spec = FrameSpec::new(1920, 1080, cell);
    let cap = spec.capacity_bytes(pal);
    let data = prng_bytes(cap, 0xBEEF ^ (cell as u32) << 8 ^ pal.bits);
    let syms = codec::bytes_to_symbols(&data, pal.bits);
    let frame = modem::render(&syms, &spec, pal);
    let seen = ch.apply(&frame);
    let got = modem::sample(&seen, &spec, pal);
    (modem::symbol_error_rate(&syms, &got), cap)
}

fn main() {
    let palettes: [&Palette; 3] = [&P2, &P4, &P8];
    let cells = [6usize, 8, 10, 14, 20];
    let channels = Channel::named();

    let _ = std::fs::create_dir_all("artifacts");
    let mut csv = String::from("channel,palette,bits,cell_px,bytes_per_frame,ser\n");

    println!("S1 — degraded-channel sweep (SER; lower is better)\n");
    for (cname, ch) in &channels {
        println!("  channel: {}", cname);
        print!("    {:<8}", "cell px");
        for c in &cells {
            print!("{:>12}", c);
        }
        println!();
        for pal in palettes {
            print!("    {:<8}", pal.name);
            for &cell in &cells {
                let (ser, cap) = trial(pal, cell, ch);
                csv.push_str(&format!(
                    "{},{},{},{},{},{:.6e}\n",
                    cname, pal.name, pal.bits, cell, cap, ser
                ));
                let mark = if ser == 0.0 { "  0" } else { "" };
                if ser == 0.0 {
                    print!("{:>12}", mark);
                } else {
                    print!("{:>12.1e}", ser);
                }
            }
            println!();
        }
        println!();
    }

    std::fs::write("artifacts/s1-sweep.csv", &csv).expect("write csv");
    println!("artifact: artifacts/s1-sweep.csv");

    // ADR-0011 is binding: some layer must survive the potato.
    let potato = Channel::potato();
    let mut survivor: Option<(&str, usize, usize)> = None;
    for pal in palettes {
        for &cell in cells.iter() {
            let (ser, cap) = trial(pal, cell, &potato);
            // Pick the highest-capacity layer that decodes clean, not the first.
            if ser == 0.0 && survivor.is_none_or(|(_, _, best)| cap > best) {
                survivor = Some((pal.name, cell, cap));
            }
        }
    }
    match survivor {
        Some((name, cell, cap)) => {
            println!(
                "\nADR-0011 potato check: PASS — best surviving layer {} @ {}px ({} B/frame)",
                name, cell, cap
            );
        }
        None => {
            eprintln!("\nADR-0011 potato check: FAIL — no layer survives the potato camera");
            std::process::exit(1);
        }
    }
}
