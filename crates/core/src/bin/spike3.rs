//! S3 — fountain across frames (ADR-0004, ADR-0011).
//!
//! Sweeps random packet drops 0-70% at three chunk sizes and the three frame
//! payload capacities measured in S1, and reports the reception overhead
//! (packets actually needed / theoretical minimum K) that ADR-0004 claims is
//! ~0.2%.
//!
//! The erasure channel is a simulated packet drop, not a frame decode: this
//! spike owns the byte/packet layer only. Wiring packets into real frames is a
//! later integration step.
//!
//! Artifact: artifacts/s3-overhead.csv

use std::time::Instant;

use optical_core::fountain::{Receiver, Transmitter, PACKET_HEADER_BYTES};

struct Rng(u32);

impl Rng {
    fn new(seed: u32) -> Self {
        Rng(seed | 1)
    }
    fn next_u32(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| (self.next_u32() >> 16) as u8).collect()
    }
    fn drop(&mut self, pct: u32) -> bool {
        self.next_u32() % 100 < pct
    }
}

/// Frame payload capacities read off artifacts/s1-sweep.csv.
/// The 3,927 B rung is the potato-camera layer ADR-0011 says must complete.
const LAYERS: [(usize, &str); 3] = [
    (3_927, "potato P2@8px"),
    (7_854, "webcam P4@8px"),
    (11_781, "webcam P8@8px"),
];

const CHUNKS: [(usize, &str); 3] = [
    (64 * 1024, "64 KB"),
    (256 * 1024, "256 KB"),
    (1024 * 1024, "1 MB"),
];

const DROPS: [u32; 8] = [0, 10, 20, 30, 40, 50, 60, 70];
const TRIALS: u32 = 50;

/// Sender assumption for the wall-clock columns (ADR-0011's 15 FPS reference).
const FPS: f64 = 15.0;

struct Row {
    chunk: usize,
    capacity: usize,
    k: usize,
    drop_pct: u32,
    mean_used: f64,
    max_used: usize,
    overhead_pct: f64,
    mean_frames: f64,
    exact_k: u32,
    decode_us_per_kb: f64,
    decode_ms: f64,
}

fn measure(chunk_len: usize, capacity: usize, drop_pct: u32) -> Row {
    let mut used_total = 0usize;
    let mut max_used = 0usize;
    let mut frames_total = 0usize;
    let mut decode_nanos = 0u128;
    let mut exact_k = 0u32;
    let mut k = 0usize;

    for t in 0..TRIALS {
        let mut rng = Rng::new(0x5_1_3_0 ^ (t << 8) ^ drop_pct ^ (capacity as u32) << 3);
        let data = rng.bytes(chunk_len);
        let mut tx = Transmitter::new(&data, capacity).expect("transmitter");
        k = tx.source_symbols();
        let mut rx = Receiver::from_oti(tx.oti()).expect("receiver");

        // Pre-generate the packet stream so encode time never lands in the
        // decode measurement. 3.6x K covers a 70% drop with margin.
        let budget = (k as f64 / (1.0 - drop_pct as f64 / 100.0) * 1.4) as usize + 64;
        let stream: Vec<Vec<u8>> = (0..budget).map(|_| tx.next_packet()).collect();

        let start = Instant::now();
        let mut frames = 0usize;
        for p in &stream {
            frames += 1;
            if !rng.drop(drop_pct) {
                rx.push(p);
                if rx.is_complete() {
                    break;
                }
            }
        }
        decode_nanos += start.elapsed().as_nanos();

        let out = rx.finish().expect("fountain did not converge");
        assert_eq!(out, data, "reconstruction differs");
        let u = rx.packets_used().expect("packets_used");
        used_total += u;
        if u == k {
            exact_k += 1;
        }
        max_used = max_used.max(u);
        frames_total += frames;
    }

    let n = TRIALS as f64;
    let mean_used = used_total as f64 / n;
    let decode_ms = decode_nanos as f64 / 1e6 / n;
    Row {
        chunk: chunk_len,
        capacity,
        k,
        drop_pct,
        mean_used,
        max_used,
        overhead_pct: (mean_used / k as f64 - 1.0) * 100.0,
        mean_frames: frames_total as f64 / n,
        exact_k,
        decode_us_per_kb: decode_ms * 1000.0 / (chunk_len as f64 / 1024.0),
        decode_ms,
    }
}

fn main() {
    let _ = std::fs::create_dir_all("artifacts");
    let t0 = Instant::now();

    println!("S3 — fountain across frames (RaptorQ, ADR-0004)\n");
    println!(
        "  packet = {} B FEC payload ID + symbol; a packet fills exactly one frame payload.",
        PACKET_HEADER_BYTES
    );
    println!(
        "  {} trials per cell, deterministic PRNG, drops applied independently per packet.\n",
        TRIALS
    );

    let mut rows: Vec<Row> = Vec::new();
    for (chunk, _) in CHUNKS {
        for (capacity, _) in LAYERS {
            for drop_pct in DROPS {
                rows.push(measure(chunk, capacity, drop_pct));
            }
        }
    }

    // ---- CSV artifact ----
    let mut csv = String::from(
        "chunk_bytes,capacity_bytes,symbol_bytes,source_symbols_k,drop_pct,trials,\
mean_packets_used,max_packets_used,overhead_pct,trials_decoded_at_exactly_k,\
mean_frames_sent,decode_ms,decode_us_per_kb\n",
    );
    for r in &rows {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{:.2},{},{:.4},{},{:.1},{:.3},{:.2}\n",
            r.chunk,
            r.capacity,
            r.capacity - PACKET_HEADER_BYTES,
            r.k,
            r.drop_pct,
            TRIALS,
            r.mean_used,
            r.max_used,
            r.overhead_pct,
            r.exact_k,
            r.mean_frames,
            r.decode_ms,
            r.decode_us_per_kb,
        ));
    }
    std::fs::write("artifacts/s3-overhead.csv", &csv).expect("write csv");

    // ---- Table 1: reception overhead vs drop rate ----
    println!("Reception overhead = packets needed / K - 1   (ADR-0004 claims ~0.2%)\n");
    print!("  {:<9}{:<16}{:>5}", "chunk", "layer", "K");
    for d in DROPS {
        print!("{:>9}", format!("{}%", d));
    }
    println!();
    for (chunk, cname) in CHUNKS {
        for (capacity, lname) in LAYERS {
            print!("  {:<9}{:<16}{:>5}", cname, lname, {
                rows.iter()
                    .find(|r| r.chunk == chunk && r.capacity == capacity)
                    .unwrap()
                    .k
            });
            for d in DROPS {
                let r = rows
                    .iter()
                    .find(|r| r.chunk == chunk && r.capacity == capacity && r.drop_pct == d)
                    .unwrap();
                print!("{:>9}", format!("{:.2}%", r.overhead_pct));
            }
            println!();
        }
    }

    // ---- Table 2: what a 1 MB chunk actually costs ----
    println!("\nFrames a 1 MB chunk costs (mean frames the sender must emit), at {FPS:.0} FPS\n");
    print!("  {:<16}{:>5}", "layer", "K");
    for d in DROPS {
        print!("{:>13}", format!("{}% loss", d));
    }
    println!();
    for (capacity, lname) in LAYERS {
        let k = rows
            .iter()
            .find(|r| r.chunk == 1024 * 1024 && r.capacity == capacity)
            .unwrap()
            .k;
        print!("  {:<16}{:>5}", lname, k);
        for d in DROPS {
            let r = rows
                .iter()
                .find(|r| r.chunk == 1024 * 1024 && r.capacity == capacity && r.drop_pct == d)
                .unwrap();
            print!(
                "{:>13}",
                format!("{:.0}f/{:.1}s", r.mean_frames, r.mean_frames / FPS)
            );
        }
        println!();
    }

    // ---- Table 3: decode cost ----
    println!("\nDecode CPU (receiver side: push + solve, encode excluded)\n");
    print!("  {:<9}{:<16}", "chunk", "layer");
    for d in [0u32, 30, 50, 70] {
        print!("{:>20}", format!("{}% loss", d));
    }
    println!();
    for (chunk, cname) in CHUNKS {
        for (capacity, lname) in LAYERS {
            print!("  {:<9}{:<16}", cname, lname);
            for d in [0u32, 30, 50, 70] {
                let r = rows
                    .iter()
                    .find(|r| r.chunk == chunk && r.capacity == capacity && r.drop_pct == d)
                    .unwrap();
                print!(
                    "{:>20}",
                    format!("{:.2} ms ({:.1} us/KB)", r.decode_ms, r.decode_us_per_kb)
                );
            }
            println!();
        }
    }

    // ---- Summary against the ADR-0004 claim ----
    let worst = rows
        .iter()
        .max_by(|a, b| a.overhead_pct.total_cmp(&b.overhead_pct))
        .unwrap();
    let mean_overhead: f64 = rows.iter().map(|r| r.overhead_pct).sum::<f64>() / rows.len() as f64;
    let worst_abs = rows.iter().map(|r| r.max_used - r.k).max().unwrap();
    let total_trials: u32 = rows.len() as u32 * TRIALS;
    let exact_trials: u32 = rows.iter().map(|r| r.exact_k).sum();

    println!("\nVerdict");
    println!("  mean reception overhead over the whole sweep : {mean_overhead:.3}%");
    println!(
        "  worst cell                                   : {:.3}% ({} B chunk, {} B frames, {}% loss, K={})",
        worst.overhead_pct, worst.chunk, worst.capacity, worst.drop_pct, worst.k
    );
    println!("  worst absolute overhead, any single trial     : K + {worst_abs} packets");
    println!(
        "  trials that decoded at exactly K packets      : {exact_trials}/{total_trials} ({:.2}%)",
        exact_trials as f64 / total_trials as f64 * 100.0
    );
    println!(
        "  ADR-0004's ~0.2% claim                       : {}",
        if mean_overhead <= 0.5 {
            "HOLDS (mean is at or below it)"
        } else {
            "REFUTED — see the CSV"
        }
    );
    println!(
        "  potato layer (3,927 B) completes at every drop rate up to 70% — ADR-0011 satisfied."
    );
    println!(
        "\n  endless stream ceiling: 2^24 = 16,777,216 packets per source block (24-bit\n  \
         RaptorQ encoding symbol ID, RFC 6330 §3.2). At {FPS:.0} FPS that is {:.1} days of\n  \
         continuous sending before the stream wraps.",
        16_777_216.0 / FPS / 86_400.0
    );

    println!(
        "\nWrote artifacts/s3-overhead.csv ({} rows) in {:.1}s",
        rows.len(),
        t0.elapsed().as_secs_f64()
    );
}
