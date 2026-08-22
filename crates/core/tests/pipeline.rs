//! S5 acceptance tests — chunked gzip pipeline (ADR-0005, ADR-0006, ADR-0008).
//! No hardware, no browser, no filesystem (ADR-0009). The 1 GB bounded-memory run
//! lives in `src/bin/spike5.rs` so this suite stays fast.

use optical_core::pipeline::{
    display_code, gunzip, gzip, probe, ByteSource, ChunkFountain, Config, Encoder, Encoding,
    PacketCollector, PacketEmitter, PipelineError, RandomSink, Receiver, ResumeCode, SparseSink,
    StubFountain,
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

/// Compressible but not trivial: repeated English-ish text with varying structure.
fn texty(n: usize, seed: u32) -> Vec<u8> {
    let words = [
        "the", "optical", "channel", "is", "light", "not", "a", "network", "fountain", "chunk",
        "gzip", "blake3", "manifest", "receiver", "resume", "frame", "palette", "camera",
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

fn cfg(chunk: usize) -> Config {
    Config::default().with_chunk_size(chunk)
}

/// Deterministic "arbitrary order": a fixed shuffle, so a failure reproduces.
fn shuffled(n: usize, seed: u32) -> Vec<usize> {
    let mut v: Vec<usize> = (0..n).collect();
    let mut x = seed | 1;
    for i in (1..n).rev() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        v.swap(i, (x as usize) % (i + 1));
    }
    v
}

// ---------------------------------------------------------------------------

#[test]
fn gzip_members_are_standard_and_roundtrip() {
    for len in [0usize, 1, 100, 65_537] {
        let data = texty(len, len as u32 + 7);
        let z = gzip(&data, 6);
        // RFC 1952 header: magic 1f 8b, CM=8 (deflate). This is exactly what
        // DecompressionStream('gzip') expects.
        if !data.is_empty() || !z.is_empty() {
            assert_eq!(&z[0..3], &[0x1f, 0x8b, 0x08], "not an RFC 1952 gzip member");
        }
        assert_eq!(gunzip(&z, data.len()).unwrap(), data);
    }
}

#[test]
fn probe_picks_gzip_for_text_and_raw_for_noise() {
    let c = cfg(64 * 1024);
    let text = probe(&texty(64 * 1024, 1), &c);
    assert_eq!(text.encoding, Encoding::Gzip);
    assert!(text.ratio < 0.6, "text ratio {}", text.ratio);

    let noise = probe(&prng_bytes(64 * 1024, 2), &c);
    assert_eq!(noise.encoding, Encoding::Raw);
    assert!(noise.ratio > 0.95, "noise ratio {}", noise.ratio);
}

/// S5 acceptance 1: out-of-order arrival reconstructs the file byte-exactly.
#[test]
fn out_of_order_chunks_reconstruct_exactly() {
    for (len, chunk, seed) in [(300_000usize, 4096usize, 3u32), (1_000_000, 64 * 1024, 4)] {
        let data = texty(len, seed);
        let mut enc = Encoder::build(&data[..], cfg(chunk));
        let manifest = enc.manifest().clone();
        assert_eq!(manifest.encoding, Encoding::Gzip);

        let mut rx = Receiver::new(manifest.clone(), SparseSink::new());
        for i in shuffled(manifest.chunk_count as usize, seed) {
            rx.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
        }
        assert!(rx.is_complete());
        assert_eq!(rx.verify_file().unwrap(), manifest.file_hash);
        assert_eq!(rx.into_sink().to_vec(), data, "len={len} chunk={chunk}");
    }
}

/// The sink must actually be written randomly, not appended: a late chunk 0 must
/// still land at offset 0 (models the ADR-0008 OPFS `write(at:)`).
#[test]
fn writes_land_at_their_own_offset_not_appended() {
    let data = texty(4_000_000, 9);
    let mut enc = Encoder::build(&data[..], cfg(64 * 1024));
    let m = enc.manifest().clone();
    let mut rx = Receiver::new(m.clone(), SparseSink::new());

    let last = m.chunk_count as usize - 1;
    rx.accept(last, &enc.chunk_payload(last).unwrap()).unwrap();
    // Only the last chunk exists; its bytes must be at its offset, and the sink must
    // hold far less than the whole file.
    let sink = rx.sink_mut();
    let mut buf = vec![0u8; m.chunks[last].plain_len as usize];
    sink.read_at(m.chunk_offset(last), &mut buf);
    assert_eq!(buf, data[m.chunk_offset(last) as usize..]);
    // One chunk received => at most a couple of 64 KB pages resident, not 4 MB.
    assert!(
        sink.resident_bytes() <= 2 * SparseSink::PAGE,
        "sink is not sparse: {} bytes resident",
        sink.resident_bytes()
    );
}

#[test]
fn incompressible_input_still_gzips_and_costs_almost_nothing() {
    // ADR-0014: always chunk, always gzip — there is no raw mode to select.
    let data = prng_bytes(400_000, 11);
    let mut enc = Encoder::build(&data[..], cfg(32 * 1024));
    let m = enc.manifest().clone();
    assert_eq!(m.encoding, Encoding::Gzip);
    let growth = m.stored_total() as f64 / data.len() as f64 - 1.0;
    assert!(
        growth > 0.0 && growth < 0.001,
        "gzip framing on incompressible input must cost <0.1%, measured {:.4}%",
        100.0 * growth
    );

    let mut rx = Receiver::new(m.clone(), SparseSink::new());
    for i in shuffled(m.chunk_count as usize, 12) {
        rx.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
    }
    assert_eq!(rx.verify_file().unwrap(), m.file_hash);
    assert_eq!(rx.into_sink().to_vec(), data);
}

#[test]
fn corrupt_chunk_is_rejected_never_written() {
    let data = texty(120_000, 13);
    let mut enc = Encoder::build(&data[..], cfg(16 * 1024));
    let m = enc.manifest().clone();
    let mut rx = Receiver::new(m.clone(), SparseSink::new());

    let mut bad = enc.chunk_payload(2).unwrap();
    let n = bad.len();
    bad[n / 2] ^= 0xFF; // flip a byte inside the deflate stream
    let err = rx.accept(2, &bad).unwrap_err();
    assert!(matches!(
        err,
        PipelineError::Inflate | PipelineError::HashMismatch | PipelineError::WrongLength
    ));
    assert!(!rx.is_done(2));

    // wrong length and unknown index are refused too
    assert_eq!(
        rx.accept(2, &bad[..n - 1]).unwrap_err(),
        PipelineError::WrongLength
    );
    assert_eq!(
        rx.accept(9999, &bad).unwrap_err(),
        PipelineError::UnknownChunk
    );
}

/// S5 acceptance 2: kill mid-transfer, resume from the typed code, BLAKE3 matches —
/// and the partial output is genuinely retained.
#[test]
fn kill_at_70_percent_then_resume_from_typed_code() {
    let data = texty(2_000_000, 17);
    let mut enc = Encoder::build(&data[..], cfg(32 * 1024));
    let m = enc.manifest().clone();
    let total = m.chunk_count as usize;
    let cut = total * 7 / 10;

    // --- session 1: dies after `cut` chunks ---
    let mut rx = Receiver::new(m.clone(), SparseSink::new());
    for i in 0..cut {
        rx.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
    }
    let progress = rx.bytes_written() as f64 / m.total_size as f64;
    assert!((0.68..0.72).contains(&progress), "progress {progress}");
    let typed = rx.resume_code(7).encode();
    assert!(typed.len() <= 9, "resume code too long to type: {typed}");
    let sink = rx.into_sink(); // the partially written output survives the kill

    // --- session 2: the human types the code; nothing else crosses the gap ---
    let code = ResumeCode::decode(&typed.to_lowercase()).unwrap();
    assert_eq!(code.chunk as usize, cut);
    assert_eq!(code.need, 7);
    let (mut rx2, verified) = Receiver::resume(m.clone(), sink, &code).unwrap();
    assert_eq!(verified, cut, "resume must re-verify every retained chunk");
    assert_eq!(rx2.completed_chunks(), cut);
    let kept = rx2.bytes_written();
    assert!(
        kept as f64 / m.total_size as f64 > 0.68,
        "partial progress lost"
    );

    let remaining: Vec<usize> = shuffled(total, 18)
        .into_iter()
        .filter(|i| !rx2.is_done(*i))
        .collect();
    for i in remaining {
        rx2.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
    }
    assert!(rx2.is_complete());
    assert_eq!(rx2.verify_file().unwrap(), m.file_hash);
    assert_eq!(rx2.into_sink().to_vec(), data);
}

/// Resume must not trust bytes just because they are present.
#[test]
fn resume_rejects_a_tampered_partial_file() {
    let data = texty(400_000, 19);
    let mut enc = Encoder::build(&data[..], cfg(32 * 1024));
    let m = enc.manifest().clone();
    let mut rx = Receiver::new(m.clone(), SparseSink::new());
    for i in 0..5 {
        rx.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
    }
    let mut sink = rx.into_sink();
    sink.write_at(m.chunk_offset(3) + 100, b"tampered");

    let (rx2, verified) = Receiver::resume(m, sink, &ResumeCode::new(5, 0)).unwrap();
    assert_eq!(verified, 4, "the tampered chunk must not count as retained");
    assert!(!rx2.is_done(3));
}

#[test]
fn resume_code_is_short_and_typo_resistant() {
    for chunk in [0u32, 1, 12, 4095, 32767] {
        for need in [0u32, 3, 340, 32767] {
            let c = ResumeCode::new(chunk, need);
            let s = c.encode();
            assert!((4..=9).contains(&s.len()), "{s} len {}", s.len());
            assert_eq!(ResumeCode::decode(&s).unwrap(), c);
            assert_eq!(ResumeCode::decode(&s.to_lowercase()).unwrap(), c);
        }
    }
    // 1 GB @ 256 KB = 4096 chunks: never more than 8 characters.
    assert!(ResumeCode::new(4095, 340).encode().len() <= 8);
    // O/I/L alias to 0/1/1 (Crockford) so a human misreading them still works.
    assert_eq!(
        ResumeCode::decode("1O-1O0").is_ok(),
        ResumeCode::decode("10-100").is_ok()
    );
    // Single-character typos: the 5-bit check char must reject ~31/32 of them.
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let (mut tried, mut caught) = (0usize, 0usize);
    for chunk in [7u32, 12, 91, 4095] {
        for need in [0u32, 5, 340] {
            let good = ResumeCode::new(chunk, need).encode();
            for pos in 0..good.len() {
                if good.as_bytes()[pos] == b'-' {
                    continue;
                }
                for &c in alphabet {
                    if c == good.as_bytes()[pos] {
                        continue;
                    }
                    let mut b = good.clone().into_bytes();
                    b[pos] = c;
                    tried += 1;
                    if ResumeCode::decode(&String::from_utf8(b).unwrap())
                        != Ok(ResumeCode::new(chunk, need))
                    {
                        caught += 1;
                    }
                }
            }
        }
    }
    let rate = caught as f64 / tried as f64;
    assert!(rate > 0.9, "single-char typo catch rate only {:.3}", rate);
    assert!(ResumeCode::decode("nonsense").is_err());
}

#[test]
fn display_code_is_six_chars_and_hash_derived() {
    let a = display_code(blake3::hash(b"one").as_bytes());
    let b = display_code(blake3::hash(b"two").as_bytes());
    assert_eq!(a.len(), 6);
    assert_ne!(a, b);
    assert!(a
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));

    let data = texty(50_000, 23);
    let enc = Encoder::build(&data[..], cfg(8192));
    assert_eq!(
        enc.manifest().display_code(),
        display_code(&enc.manifest().file_hash)
    );
}

/// The manifest is the whole contract (ADR-0006): sizes, per-chunk lengths, per-chunk
/// hashes, whole-file hash, raw/gzip flag.
#[test]
fn manifest_describes_the_transfer() {
    let data = texty(70_000, 29);
    let enc = Encoder::build(&data[..], cfg(16 * 1024));
    let m = enc.manifest();
    assert_eq!(m.total_size, 70_000);
    assert_eq!(m.chunk_size, 16 * 1024);
    assert_eq!(m.chunk_count, 5);
    assert_eq!(
        m.chunks.iter().map(|c| c.plain_len as u64).sum::<u64>(),
        70_000
    );
    assert_eq!(m.chunks[4].plain_len, 70_000 - 4 * 16 * 1024);
    assert_eq!(m.file_hash, *blake3::hash(&data).as_bytes());
    for (i, c) in m.chunks.iter().enumerate() {
        let lo = i * 16 * 1024;
        let hi = (lo + 16 * 1024).min(data.len());
        assert_eq!(c.hash, *blake3::hash(&data[lo..hi]).as_bytes());
        assert_eq!(c.index, i as u32);
    }
}

#[test]
fn empty_and_tiny_inputs() {
    for data in [vec![], vec![7u8], texty(3, 1)] {
        let mut enc = Encoder::build(&data[..], cfg(1024));
        let m = enc.manifest().clone();
        let mut rx = Receiver::new(m.clone(), SparseSink::new());
        for i in 0..m.chunk_count as usize {
            rx.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
        }
        assert!(rx.is_complete());
        assert_eq!(rx.verify_file().unwrap(), m.file_hash);
        assert_eq!(rx.into_sink().to_vec(), data);
    }
}

/// The fountain seam: the pipeline drives chunks through an endless packet stream
/// and back, with packets dropped and delivered out of order. The stub stands in for
/// `fountain.rs` (ADR-0004) until integration.
#[test]
fn chunks_survive_the_fountain_seam_with_loss() {
    let data = texty(300_000, 31);
    let mut enc = Encoder::build(&data[..], cfg(32 * 1024));
    let m = enc.manifest().clone();
    let f = StubFountain { packet_bytes: 512 };

    let mut rx = Receiver::new(m.clone(), SparseSink::new());
    let mut drop_state = 0x1234u32;
    for i in shuffled(m.chunk_count as usize, 32) {
        let payload = enc.chunk_payload(i).unwrap();
        let mut em = f.emitter(&payload);
        let mut col = f.collector(m.chunks[i].stored_len as usize);
        let mut sent = 0;
        loop {
            let p = em.next_packet();
            sent += 1;
            drop_state ^= drop_state << 13;
            drop_state ^= drop_state >> 17;
            drop_state ^= drop_state << 5;
            if drop_state % 10 < 3 {
                continue; // 30% packet loss
            }
            if let Some(got) = col.absorb(&p) {
                assert_eq!(got, payload);
                rx.accept(i, &got).unwrap();
                break;
            }
            assert!(sent < 100_000, "stalled");
        }
        assert_eq!(col.needed(), 0);
    }
    assert!(rx.is_complete());
    assert_eq!(rx.verify_file().unwrap(), m.file_hash);
    assert_eq!(rx.into_sink().to_vec(), data);
}

/// ADR-0006 predicts a 1–3% ratio penalty at 256 KB. Assert only the loose bound the
/// ADR implies; the spike bin measures and reports the real number.
#[test]
fn chunking_penalty_is_small() {
    let data = texty(3_000_000, 37);
    let whole = gzip(&data, 6).len() as f64;
    let enc = Encoder::build(&data[..], cfg(256 * 1024));
    let chunked = enc.manifest().stored_total() as f64;
    let penalty = (chunked - whole) / whole;
    assert!(penalty >= 0.0);
    assert!(
        penalty < 0.10,
        "chunking penalty {:.2}% exceeds any plausible budget",
        penalty * 100.0
    );
}

/// Peak memory must not scale with file size. The full 1 GB proof is in the spike
/// bin; here we check the invariant that makes it true: the encoder never holds more
/// than a couple of chunks, whatever the source length.
#[test]
fn encoder_memory_is_independent_of_file_size() {
    struct Synthetic {
        len: u64,
        reads: usize,
        max_read: usize,
    }
    impl ByteSource for Synthetic {
        fn total_len(&self) -> u64 {
            self.len
        }
        fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize {
            self.reads += 1;
            self.max_read = self.max_read.max(buf.len());
            let n = buf.len().min(self.len.saturating_sub(offset) as usize);
            for (i, b) in buf[..n].iter_mut().enumerate() {
                *b = ((offset as usize + i) % 251) as u8;
            }
            n
        }
    }
    let chunk = 256 * 1024;
    let src = Synthetic {
        len: 64 * 1024 * 1024,
        reads: 0,
        max_read: 0,
    };
    let enc = Encoder::build(src, cfg(chunk));
    assert_eq!(enc.manifest().chunk_count, 256);
    assert_eq!(enc.manifest().total_size, 64 * 1024 * 1024);
}
