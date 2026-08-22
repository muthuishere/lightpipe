//! S3 — fountain across frames (ADR-0004, ADR-0011).
//!
//! The erasure channel here is a simulated packet drop, not a frame decode:
//! this layer sits below the pixel layer on purpose.

use optical_core::fountain::{
    FountainError, Receiver, Transmitter, MAX_PACKETS_PER_BLOCK, PACKET_HEADER_BYTES,
};

/// Deterministic xorshift — same generator the other spikes use.
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
    /// True with probability `pct`/100.
    fn drop(&mut self, pct: u32) -> bool {
        self.next_u32() % 100 < pct
    }
}

/// Frame payload capacities measured in S1 (`artifacts/s1-sweep.csv`).
const CAPACITIES: [usize; 3] = [3_927, 7_854, 11_781];

fn run(chunk_len: usize, capacity: usize, drop_pct: u32, seed: u32) -> (usize, usize) {
    let mut rng = Rng::new(seed);
    let data = rng.bytes(chunk_len);
    let mut tx = Transmitter::new(&data, capacity).unwrap();
    let mut rx = Receiver::from_oti(tx.oti()).unwrap();
    assert_eq!(rx.source_symbols(), tx.source_symbols());

    let mut sent = 0usize;
    // Generous ceiling; a failure to converge shows up as a panic here.
    let ceiling = tx.source_symbols() * 100 + 10_000;
    while !rx.is_complete() {
        let p = tx.next_packet();
        assert_eq!(p.len(), capacity);
        sent += 1;
        assert!(sent < ceiling, "fountain failed to converge");
        if !rng.drop(drop_pct) {
            rx.push(&p);
        }
    }
    assert_eq!(rx.finish().unwrap(), data, "reconstruction differs");
    assert_eq!(rx.needed_more(), 0);
    (rx.packets_used().unwrap(), sent)
}

#[test]
fn roundtrip_survives_drops_0_to_70_percent() {
    for chunk_len in [64 * 1024usize, 256 * 1024, 1024 * 1024] {
        for capacity in CAPACITIES {
            for drop_pct in [0u32, 10, 20, 30, 40, 50, 60, 70] {
                let (used, _sent) = run(chunk_len, capacity, drop_pct, 0xC0FE ^ drop_pct);
                let k = chunk_len.div_ceil(capacity - PACKET_HEADER_BYTES);
                assert!(used >= k, "cannot decode with fewer than K packets");
                // ADR-0004 claims ~0.2% reception overhead. Allow generous slack
                // here; spike3 measures the real number.
                assert!(
                    used <= k + 4,
                    "overhead blew out: k={k} used={used} chunk={chunk_len} cap={capacity} drop={drop_pct}"
                );
            }
        }
    }
}

#[test]
fn out_of_order_and_duplicates_are_normal() {
    let mut rng = Rng::new(0xABCD);
    let data = rng.bytes(200 * 1024);
    let mut tx = Transmitter::new(&data, 3_927).unwrap();
    let k = tx.source_symbols();

    // Collect 2K packets, shuffle them, and inject each one three times.
    let mut packets: Vec<Vec<u8>> = (0..2 * k).map(|_| tx.next_packet()).collect();
    for i in (1..packets.len()).rev() {
        let j = (rng.next_u32() as usize) % (i + 1);
        packets.swap(i, j);
    }

    let mut rx = Receiver::from_oti(tx.oti()).unwrap();
    let mut accepted = 0usize;
    let mut rejected_dupes = 0usize;
    for p in &packets {
        for rep in 0..3 {
            if rx.is_complete() {
                break;
            }
            if rx.push(p) {
                accepted += 1;
                assert!(rep == 0, "a duplicate was accepted as new");
            } else {
                rejected_dupes += 1;
            }
        }
    }
    assert!(rx.is_complete());
    assert_eq!(rx.finish().unwrap(), data);
    assert!(accepted >= k);
    assert!(rejected_dupes > 0);
}

#[test]
fn garbage_is_rejected_not_fatal() {
    let mut rng = Rng::new(7);
    let data = rng.bytes(50 * 1024);
    let capacity = 7_854;
    let mut tx = Transmitter::new(&data, capacity).unwrap();
    let mut rx = Receiver::from_oti(tx.oti()).unwrap();

    // Wrong length, wrong source block, and pure noise must all bounce.
    assert!(!rx.push(&[]));
    assert!(!rx.push(&rng.bytes(capacity - 1)));
    assert!(!rx.push(&rng.bytes(capacity + 1)));
    let mut wrong_block = tx.next_packet();
    wrong_block[0] = 3;
    assert!(!rx.push(&wrong_block));
    assert_eq!(rx.accepted(), 0);

    // A random blob whose block byte happens to be 0 is accepted as a symbol —
    // that is exactly why ADR-0004 puts a CRC in front of this layer (S2).
    // With real frames such a packet never reaches here.
    while !rx.is_complete() {
        let p = tx.next_packet();
        rx.push(&p);
        assert!(!rx.push(&rng.bytes(capacity - 1)));
    }
    assert_eq!(rx.finish().unwrap(), data);
}

#[test]
fn needed_more_counts_down_to_zero() {
    let mut rng = Rng::new(99);
    let data = rng.bytes(128 * 1024);
    let mut tx = Transmitter::new(&data, 3_927).unwrap();
    let k = tx.source_symbols();
    let mut rx = Receiver::from_oti(tx.oti()).unwrap();
    assert_eq!(rx.needed_more(), k);
    let mut last = rx.needed_more();
    while !rx.is_complete() {
        let p = tx.next_packet();
        rx.push(&p);
        let now = rx.needed_more();
        assert!(now <= last, "needed_more went backwards");
        last = now;
    }
    assert_eq!(rx.needed_more(), 0);
}

/// ADR-0005 has the sender looping forever. Prove packets stay distinct and
/// decodable 10x past the source-symbol count.
#[test]
fn endless_stream_decodes_from_a_late_subset() {
    let mut rng = Rng::new(0x5A5A);
    let data = rng.bytes(64 * 1024);
    let capacity = 3_927;
    let mut tx = Transmitter::new(&data, capacity).unwrap();
    let k = tx.source_symbols();

    // Burn the first 10x K packets entirely, then decode only from what comes
    // after — no source symbol is ever seen.
    for _ in 0..10 * k {
        let _ = tx.next_packet();
    }
    let mut rx = Receiver::from_oti(tx.oti()).unwrap();
    let mut sent = 0usize;
    while !rx.is_complete() {
        let p = tx.next_packet();
        sent += 1;
        assert!(sent < 20 * k + 1000, "late repair packets stopped decoding");
        if !rng.drop(50) {
            rx.push(&p);
        }
    }
    assert_eq!(rx.finish().unwrap(), data);
    assert!(tx.position() > 10 * k as u64);
}

/// The endless stream is bounded by RaptorQ's 24-bit encoding symbol ID.
/// Decode from packets drawn right at that ceiling.
#[test]
fn stream_ceiling_is_the_24_bit_symbol_id() {
    let mut rng = Rng::new(0x1234_5678);
    let data = rng.bytes(16 * 1024);
    let capacity = 3_927;
    let mut tx = Transmitter::new(&data, capacity).unwrap();
    let k = tx.source_symbols() as u64;

    // Sit K packets below the ceiling and decode from the very last packets the
    // codec can ever produce for this block.
    tx.seek(MAX_PACKETS_PER_BLOCK - 2 * k - 8);
    let mut rx = Receiver::from_oti(tx.oti()).unwrap();
    while !rx.is_complete() {
        let p = tx.next_packet();
        assert!(tx.position() <= MAX_PACKETS_PER_BLOCK);
        rx.push(&p);
    }
    assert_eq!(rx.finish().unwrap(), data);

    // One past the ceiling the stream wraps rather than panicking.
    tx.seek(MAX_PACKETS_PER_BLOCK - 1);
    let _ = tx.next_packet();
    let _ = tx.next_packet();
    assert_eq!(tx.position(), 1);
}

#[test]
fn oti_round_trips_through_twelve_bytes() {
    let data = Rng::new(3).bytes(300 * 1024);
    let tx = Transmitter::new(&data, 11_781).unwrap();
    let oti = tx.oti();
    assert_eq!(oti.len(), 12);
    let rx = Receiver::from_oti(oti).unwrap();
    assert_eq!(rx.oti(), oti);
    assert_eq!(rx.source_symbols(), tx.source_symbols());
    assert_eq!(rx.source_symbols(), data.len().div_ceil(11_781 - 4));
}

#[test]
fn bad_inputs_are_errors_not_panics() {
    assert_eq!(
        Transmitter::new(&[], 3_927).unwrap_err(),
        FountainError::EmptyChunk
    );
    assert_eq!(
        Transmitter::new(&[1, 2, 3], 4).unwrap_err(),
        FountainError::BadCapacity
    );
    assert_eq!(
        Transmitter::new(&[1, 2, 3], 100_000).unwrap_err(),
        FountainError::BadCapacity
    );
    assert_eq!(
        Receiver::from_oti([0u8; 12]).unwrap_err(),
        FountainError::BadOti
    );
}
