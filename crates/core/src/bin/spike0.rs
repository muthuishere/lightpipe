//! S0 — palette + cell round-trip on a perfect channel.
//! Proves bytes -> symbols -> pixels -> symbols -> bytes loses nothing.
//! Artifact: artifacts/s0-frame.png

use optical_core::codec;
use optical_core::modem;
use optical_core::sim::Channel;
use optical_core::{FrameSpec, P4, P8};

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

fn main() {
    println!("S0 — cell round-trip, perfect channel\n");
    let ideal = Channel::ideal();
    let mut all_ok = true;

    for pal in [&P4, &P8] {
        for cell in [8usize, 10, 14] {
            let spec = FrameSpec::new(1920, 1080, cell);
            let cap = spec.capacity_bytes(pal);
            let data = prng_bytes(cap, 0xC0FFEE ^ cell as u32);

            let syms = codec::bytes_to_symbols(&data, pal.bits);
            let frame = modem::render(&syms, &spec, pal);
            let seen = ideal.apply(&frame);
            let got_syms = modem::sample(&seen, &spec, pal);
            let got = codec::symbols_to_bytes(&got_syms, pal.bits, data.len());

            let ser = modem::symbol_error_rate(&syms, &got_syms);
            let ok = got == data;
            all_ok &= ok;
            println!(
                "  {} cell={:>2}px  grid {}x{}  {:>6} B/frame  SER {:.2e}  {}",
                pal.name,
                cell,
                spec.cols(),
                spec.rows(),
                cap,
                ser,
                if ok { "OK" } else { "FAIL" }
            );

            if pal.name == "P4" && cell == 10 {
                let _ = std::fs::create_dir_all("artifacts");
                frame.save_png("artifacts/s0-frame.png").expect("write png");
            }
        }
    }

    println!("\nartifact: artifacts/s0-frame.png");
    if !all_ok {
        eprintln!("S0 FAILED");
        std::process::exit(1);
    }
    println!("S0 PASS");
}
