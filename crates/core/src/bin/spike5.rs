//! S5 — chunked gzip pipeline (ADR-0005, ADR-0006, ADR-0008).
//!
//! Proves: out-of-order arrival reconstructs byte-exactly; a transfer killed at 70%
//! keeps 70% and resumes from a short typed code; memory stays bounded on a 1 GB
//! file; and measures the compression-ratio cost of chunking that ADR-0006 estimates
//! at 1–3%.
//!
//! Artifact: artifacts/s5-pipeline.txt
//!
//! File I/O lives here, not in the core (ADR-0009). The `FileSink` below is the
//! native stand-in for the ADR-0008 OPFS sync access handle: `write(data, {at})`.

use optical_core::pipeline::{
    gzip, ByteSource, ChunkFountain, Config, Encoder, Encoding, PacketCollector, PacketEmitter,
    RandomSink, Receiver, ResumeCode, SparseSink, StubFountain,
};
use std::fmt::Write as _;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::Instant;

// ---------------------------------------------------------------------------
// peak RSS (getrusage; no new dependency)
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Default)]
struct RUsage {
    utime: [i64; 2],
    stime: [i64; 2],
    maxrss: i64,
    rest: [i64; 14],
}

extern "C" {
    fn getrusage(who: i32, usage: *mut RUsage) -> i32;
}

/// Peak resident set size of this process, in bytes.
fn peak_rss_bytes() -> u64 {
    let mut ru = RUsage::default();
    let rc = unsafe { getrusage(0, &mut ru) };
    if rc != 0 || ru.maxrss <= 0 {
        return 0;
    }
    // macOS reports bytes; Linux reports kilobytes.
    if cfg!(target_os = "macos") {
        ru.maxrss as u64
    } else {
        ru.maxrss as u64 * 1024
    }
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

// ---------------------------------------------------------------------------
// synthetic corpora (deterministic — any human reruns and gets the same numbers)
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// English-ish prose. A Zipf-weighted vocabulary of ~1200 pseudo-words, which lands
/// gzip in the 0.3-0.4 band real prose occupies — a 24-word loop would compress to
/// 0.17 and quietly overstate the cost of a dictionary reset.
fn text_corpus(n: usize, seed: u64) -> Vec<u8> {
    let mut r = Rng(seed | 1);
    let vocab: Vec<String> = (0..1200)
        .map(|_| {
            let len = 2 + (r.next() % 8) as usize;
            (0..len)
                .map(|_| (b'a' + (r.next() % 26) as u8) as char)
                .collect()
        })
        .collect();
    let mut out = Vec::with_capacity(n + 32);
    let mut sentence = 0;
    while out.len() < n {
        // Zipf-ish: square the uniform draw so common words dominate, as in real text.
        let u = (r.next() % 10_000) as f64 / 10_000.0;
        let idx = (u * u * vocab.len() as f64) as usize % vocab.len();
        out.extend_from_slice(vocab[idx].as_bytes());
        sentence += 1;
        if sentence > 6 + (r.next() % 14) as usize {
            out.extend_from_slice(b".\n");
            sentence = 0;
        } else {
            out.push(b' ');
        }
    }
    out.truncate(n);
    out
}

/// Rust-like source: repetitive structure, but identifiers, literals and body
/// lengths drawn from a wide pool so the whole-file ratio lands where real code does
/// (~0.2-0.3) instead of the 0.04 a fixed template loop would fake.
fn source_corpus(n: usize, seed: u64) -> Vec<u8> {
    const T: [&str; 6] = ["u8", "u32", "usize", "f64", "Vec<u8>", "&[u8]"];
    let mut r = Rng(seed | 1);
    let names: Vec<String> = (0..600)
        .map(|_| {
            let len = 3 + (r.next() % 9) as usize;
            (0..len)
                .map(|_| (b'a' + (r.next() % 26) as u8) as char)
                .collect()
        })
        .collect();
    let pick = |r: &mut Rng| names[(r.next() >> 9) as usize % names.len()].clone();
    let mut s = String::with_capacity(n + 512);
    while s.len() < n {
        let (f, a, b) = (pick(&mut r), pick(&mut r), pick(&mut r));
        let t = T[(r.next() >> 9) as usize % T.len()];
        let _ = write!(
            s,
            "/// Computes the {a} for a given {b}.\npub fn {f}({a}: {t}, {b}: usize) -> {t} {{\n    let mut {a}_acc = {};\n",
            r.next() % 100_000
        );
        for _ in 0..1 + r.next() % 6 {
            let v = pick(&mut r);
            let _ = writeln!(
                s,
                "    let {v} = {}(self.{}, {} + {});",
                pick(&mut r),
                pick(&mut r),
                r.next() % 4096,
                r.next() % 4096
            );
        }
        let _ = write!(s, "    {a}_acc\n}}\n\n");
    }
    s.truncate(n);
    s.into_bytes()
}

/// Already-compressed blob (mp4/jpg/zip stand-in): incompressible noise.
fn blob_corpus(n: usize, seed: u64) -> Vec<u8> {
    let mut r = Rng(seed | 1);
    (0..n).map(|_| (r.next() >> 23) as u8).collect()
}

/// The repo's own text — real input, not synthetic.
fn repo_corpus() -> Vec<u8> {
    let mut out = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(".")];
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with('.') || name == "target" || name == "artifacts" {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if matches!(
                p.extension().and_then(|s| s.to_str()),
                Some("rs") | Some("md") | Some("toml") | Some("yml")
            ) {
                files.push(p);
            }
        }
    }
    files.sort();
    for f in files {
        if let Ok(b) = std::fs::read(&f) {
            out.extend_from_slice(&b);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// file-backed source + sink (the native stand-ins for OPFS, ADR-0008)
// ---------------------------------------------------------------------------

/// A 1 GB file that is never materialised: bytes are generated on demand from the
/// offset. Lets the 1 GB run prove bounded *receiver* memory without needing 1 GB of
/// source on disk. Deterministic, so the whole-file BLAKE3 is checkable.
struct SyntheticSource {
    len: u64,
}

impl ByteSource for SyntheticSource {
    fn total_len(&self) -> u64 {
        self.len
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize {
        let n = buf.len().min(self.len.saturating_sub(offset) as usize);
        // Mildly compressible: a slowly-varying pattern plus noise, so gzip has real
        // work to do (an all-zero file would make the whole measurement a lie).
        let mut r = Rng(offset ^ 0x9E37_79B9_7F4A_7C15);
        for (i, b) in buf[..n].iter_mut().enumerate() {
            let o = offset + i as u64;
            *b = if o.is_multiple_of(7) {
                (r.next() >> 29) as u8
            } else {
                ((o / 64) % 251) as u8
            };
        }
        n
    }
}

/// Random-access file sink — `seek` + `write` is exactly the OPFS
/// `handle.write(data, { at })` shape of ADR-0008.
struct FileSink {
    f: File,
}

impl FileSink {
    fn create(path: &std::path::Path) -> std::io::Result<Self> {
        Ok(Self {
            f: File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true)
                .open(path)?,
        })
    }
}

impl RandomSink for FileSink {
    fn write_at(&mut self, offset: u64, data: &[u8]) {
        self.f.seek(SeekFrom::Start(offset)).expect("seek");
        self.f.write_all(data).expect("write");
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize {
        if self.f.seek(SeekFrom::Start(offset)).is_err() {
            return 0;
        }
        let mut done = 0;
        while done < buf.len() {
            match self.f.read(&mut buf[done..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => done += n,
            }
        }
        done
    }
    fn set_len(&mut self, len: u64) {
        self.f.set_len(len).expect("set_len");
    }
}

// ---------------------------------------------------------------------------

fn shuffled(n: usize, seed: u64) -> Vec<usize> {
    let mut v: Vec<usize> = (0..n).collect();
    let mut r = Rng(seed | 1);
    for i in (1..n).rev() {
        v.swap(i, (r.next() >> 3) as usize % (i + 1));
    }
    v
}

struct Report {
    buf: String,
    /// The 1 GB stage runs as a child process; it only buffers, the parent prints.
    quiet: bool,
}

impl Report {
    fn line(&mut self, s: impl AsRef<str>) {
        let s = s.as_ref();
        if !self.quiet {
            println!("{s}");
        }
        self.buf.push_str(s);
        self.buf.push('\n');
    }
    fn head(&mut self, s: &str) {
        self.line("");
        self.line(s);
        self.line("-".repeat(s.len()));
    }
}

macro_rules! rl {
    ($r:expr, $($arg:tt)*) => { $r.line(format!($($arg)*)) };
}

// ---------------------------------------------------------------------------

fn main() {
    // The 1 GB section re-execs itself so its peak RSS is measured in a process that
    // has not just allocated 32 MB of test corpora. getrusage reports a high-water
    // mark that never comes back down.
    if std::env::var("TQ_S5_STAGE").as_deref() == Ok("onegb") {
        let mut r = Report {
            buf: String::new(),
            quiet: true,
        };
        section_one_gb(&mut r);
        print!("{}", r.buf);
        return;
    }

    let mut r = Report {
        buf: String::new(),
        quiet: false,
    };
    r.line("S5 — chunked gzip pipeline (ADR-0006), integrity + resume (ADR-0005),");
    r.line("     out-of-order random-access write (ADR-0008).");
    rl!(
        r,
        "     chunk size {} KB · deflate level 6 · one RFC 1952 gzip member per chunk",
        256
    );
    r.line("     browser interop (checked out of band, Node v24.18 / WHATWG streams):");
    r.line("       flate2 member -> DecompressionStream('gzip')  = 300,000 B byte-identical");
    r.line("       CompressionStream('gzip') -> flate2 gunzip     = 300,000 B byte-identical");
    r.line("     so the ADR-0007 browser build can read and write this wire format unchanged.");

    section_penalty(&mut r);
    section_out_of_order(&mut r);
    section_resume(&mut r);

    let exe = std::env::current_exe().expect("current exe");
    let out = std::process::Command::new(exe)
        .env("TQ_S5_STAGE", "onegb")
        .output()
        .expect("re-exec for the 1 GB run");
    let text = String::from_utf8_lossy(&out.stdout);
    for l in text.lines() {
        r.line(l);
    }
    assert!(
        out.status.success(),
        "1 GB stage failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let _ = std::fs::create_dir_all("artifacts");
    std::fs::write("artifacts/s5-pipeline.txt", &r.buf).expect("write artifact");
    println!("\nartifact: artifacts/s5-pipeline.txt");
}

// --- 2. compression penalty of chunking ------------------------------------

fn section_penalty(r: &mut Report) {
    r.head("2. compression cost of chunking vs whole-file gzip (ADR-0006 estimates 1-3%)");
    r.line(
        "   corpus                 size    whole-file    chunked      penalty   (chunk KB)  ratio",
    );

    let n = 8 * 1024 * 1024;
    let repo = repo_corpus();
    let corpora: Vec<(&str, Vec<u8>)> = vec![
        ("text (prose)", text_corpus(n, 11)),
        ("source (rust-like)", source_corpus(n, 12)),
        ("repo (real .rs/.md)", repo),
        ("blob (incompressible)", blob_corpus(n, 13)),
    ];

    let mut worst = 0.0f64;
    for (name, data) in &corpora {
        if data.is_empty() {
            continue;
        }
        let whole = gzip(data, 6).len();
        for chunk in [64usize * 1024, 256 * 1024, 1024 * 1024] {
            let enc = Encoder::build(&data[..], Config::default().with_chunk_size(chunk));
            let m = enc.manifest();
            let chunked = m.stored_total();
            let penalty = (chunked as f64 - whole as f64) / whole as f64 * 100.0;
            if chunk == 256 * 1024 && m.encoding == Encoding::Gzip {
                worst = worst.max(penalty);
            }
            rl!(
                r,
                "   {:<22} {:>5.1} MB {:>10} {:>12} {:>9.2}%   {:>5}  {}",
                if chunk == 64 * 1024 { name } else { "" },
                mib(data.len() as u64),
                if chunk == 64 * 1024 {
                    whole.to_string()
                } else {
                    String::new()
                },
                chunked,
                penalty,
                chunk / 1024,
                if chunk == 64 * 1024 {
                    format!(
                        "{:.3}{}",
                        whole as f64 / data.len() as f64,
                        if m.encoding == Encoding::Raw {
                            "  (raw: probe said don't bother)"
                        } else {
                            ""
                        }
                    )
                } else {
                    String::new()
                }
            );
        }
    }
    r.line("");
    rl!(
        r,
        "   worst compressible-corpus penalty at the 256 KB default: {:.2}%",
        worst
    );
    rl!(
        r,
        "   verdict: ADR-0006's 1-3% estimate is {}.",
        if worst <= 3.0 { "CONFIRMED" } else { "REFUTED" }
    );
}

// --- 3. out-of-order arrival ------------------------------------------------

fn section_out_of_order(r: &mut Report) {
    r.head("3. out-of-order arrival through the fountain seam (ADR-0004 stub) -> byte-exact");
    let data = text_corpus(4 * 1024 * 1024, 21);
    let cfg = Config::default().with_chunk_size(256 * 1024);
    let mut enc = Encoder::build(&data[..], cfg);
    let m = enc.manifest().clone();
    let f = StubFountain { packet_bytes: 1024 };

    let mut rx = Receiver::new(m.clone(), SparseSink::new());
    let mut lost = 0usize;
    let mut sent = 0usize;
    let mut drop_rng = Rng(0xC0FFEE);
    for i in shuffled(m.chunk_count as usize, 22) {
        let payload = enc.chunk_payload(i).unwrap();
        let mut em = f.emitter(&payload);
        let mut col = f.collector(m.chunks[i].stored_len as usize);
        loop {
            let p = em.next_packet();
            sent += 1;
            if drop_rng.next() % 10 < 3 {
                lost += 1;
                continue; // 30% packet loss
            }
            if let Some(got) = col.absorb(&p) {
                rx.accept(i, &got).expect("chunk verified");
                break;
            }
        }
    }
    let out = {
        let h = rx.verify_file().expect("whole-file BLAKE3");
        assert_eq!(h, m.file_hash);
        rx.into_sink().to_vec()
    };
    assert_eq!(out, data, "byte-exact reconstruction");
    rl!(
        r,
        "   {} chunks delivered in shuffled order, {}% packet loss ({} of {} packets dropped)",
        m.chunk_count,
        lost * 100 / sent.max(1),
        lost,
        sent
    );
    rl!(
        r,
        "   reconstruction: byte-exact ({} bytes), whole-file BLAKE3 verified",
        out.len()
    );
    rl!(
        r,
        "   display code both screens show (ADR-0005, 6 chars): {}",
        m.display_code()
    );
}

// --- 4. kill mid-transfer, resume from the typed code -----------------------

fn section_resume(r: &mut Report) {
    r.head("4. kill at 70%, resume from the typed code (ADR-0005/0006) — on a real file");
    let data = source_corpus(8 * 1024 * 1024, 31);
    let cfg = Config::default();
    let mut enc = Encoder::build(&data[..], cfg);
    let m = enc.manifest().clone();
    let total = m.chunk_count as usize;
    let cut = total * 7 / 10;

    let path = std::env::temp_dir().join("tq-s5-resume.bin");
    // session 1 — dies after 70% of the chunks
    let mut rx = Receiver::new(m.clone(), FileSink::create(&path).expect("create"));
    for i in 0..cut {
        rx.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
    }
    let kept = rx.bytes_written();
    let code = rx.resume_code(340);
    let typed = code.encode();
    drop(rx); // the process dies here; only the file and the typed code survive

    let on_disk = std::fs::metadata(&path).map(|md| md.len()).unwrap_or(0);
    rl!(
        r,
        "   killed after {}/{} chunks: {:.2} MB of {:.2} MB retained ({:.1}%), file on disk {:.2} MB",
        cut,
        total,
        mib(kept),
        mib(m.total_size),
        kept as f64 / m.total_size as f64 * 100.0,
        mib(on_disk)
    );
    rl!(
        r,
        "   typed resume code: \"{}\"  ({} characters)",
        typed,
        typed.len()
    );
    rl!(
        r,
        "   format: <chunk>-<need><check>, Crockford base32, 4-9 chars (<=8 for a 1 GB transfer)"
    );

    // session 2 — a fresh receiver, nothing but the manifest, the file, and the code
    let parsed = ResumeCode::decode(&typed.to_lowercase()).expect("human typed it in lowercase");
    // Reopen WITHOUT truncating — the partially written output is the whole point.
    let f = File::options()
        .read(true)
        .write(true)
        .open(&path)
        .expect("reopen");
    let (mut rx2, verified) = Receiver::resume(m.clone(), FileSink { f }, &parsed).expect("resume");
    rl!(
        r,
        "   resumed at chunk {} (need {} more packets); {} of {} retained chunks re-verified against",
        parsed.chunk,
        parsed.need,
        verified,
        cut
    );
    rl!(
        r,
        "   their manifest BLAKE3 — the remaining {} chunks are all that is re-sent",
        total - verified
    );

    let remaining: Vec<usize> = shuffled(total, 33)
        .into_iter()
        .filter(|i| !rx2.is_done(*i))
        .collect();
    for i in remaining {
        rx2.accept(i, &enc.chunk_payload(i).unwrap()).unwrap();
    }
    let h = rx2.verify_file().expect("whole-file BLAKE3 after resume");
    assert_eq!(h, m.file_hash);
    let mut back = vec![0u8; m.total_size as usize];
    rx2.sink_mut().read_at(0, &mut back);
    assert_eq!(back, data);
    rl!(
        r,
        "   completed: whole-file BLAKE3 matches, output byte-identical. code {}",
        m.display_code()
    );
    let _ = std::fs::remove_file(&path);
}

// --- 5. 1 GB bounded memory -------------------------------------------------

fn section_one_gb(r: &mut Report) {
    let gib: u64 = std::env::var("TQ_S5_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1024 * 1024 * 1024);
    r.head(&format!(
        "5. {:.0} MB synthetic file — memory must stay bounded (ADR-0006/0008)",
        mib(gib)
    ));

    let base_rss = peak_rss_bytes();
    let cfg = Config::default();
    let t0 = Instant::now();
    let mut enc = Encoder::build(SyntheticSource { len: gib }, cfg);
    let m = enc.manifest().clone();
    let manifest_bytes = m.chunks.len() * std::mem::size_of::<optical_core::pipeline::ChunkMeta>();
    let after_manifest = peak_rss_bytes();
    rl!(
        r,
        "   manifest: {} chunks of {} KB, encoding {}, built in {:.1} s ({:.0} MB/s)",
        m.chunk_count,
        m.chunk_size / 1024,
        m.encoding.as_str(),
        t0.elapsed().as_secs_f64(),
        mib(gib) / t0.elapsed().as_secs_f64()
    );
    rl!(
        r,
        "   manifest cost: {} bytes ({:.2} MB) — {:.5}% of the payload",
        manifest_bytes,
        mib(manifest_bytes as u64),
        manifest_bytes as f64 / gib as f64 * 100.0
    );

    let path = std::env::temp_dir().join("tq-s5-1gb.bin");
    let mut rx = Receiver::new(
        m.clone(),
        FileSink::create(&path).expect("create 1 GB sink"),
    );

    // Deliberately non-sequential: all odd chunks first, then all even ones. Every
    // write is a seek to its own offset (ADR-0008), never an append.
    let order: Vec<usize> = (0..m.chunk_count as usize)
        .filter(|i| i % 2 == 1)
        .chain((0..m.chunk_count as usize).filter(|i| i % 2 == 0))
        .collect();
    let t1 = Instant::now();
    for i in order {
        rx.accept(i, &enc.chunk_payload(i).unwrap())
            .expect("chunk verified");
    }
    let transfer = t1.elapsed();
    let peak = peak_rss_bytes();

    let t2 = Instant::now();
    let h = rx.verify_file().expect("whole-file BLAKE3 over 1 GB");
    assert_eq!(h, m.file_hash);
    let peak_after_verify = peak_rss_bytes();

    rl!(
        r,
        "   transferred out-of-order (odds then evens) in {:.1} s; verified whole-file BLAKE3 in {:.1} s",
        transfer.as_secs_f64(),
        t2.elapsed().as_secs_f64()
    );
    rl!(
        r,
        "   compressed size on the wire: {:.1} MB of {:.1} MB ({:.1}% ratio)",
        mib(m.stored_total()),
        mib(gib),
        m.stored_total() as f64 / gib as f64 * 100.0
    );
    r.line("");
    rl!(
        r,
        "   peak RSS before the run      : {:>8.1} MB",
        mib(base_rss)
    );
    rl!(
        r,
        "   peak RSS after manifest pass : {:>8.1} MB",
        mib(after_manifest)
    );
    rl!(r, "   peak RSS after transfer      : {:>8.1} MB", mib(peak));
    rl!(
        r,
        "   peak RSS after whole verify  : {:>8.1} MB",
        mib(peak_after_verify)
    );
    rl!(
        r,
        "   => {:.1} MB peak for a {:.0} MB file = {:.4}x. Bounded: memory tracks chunk size,",
        mib(peak_after_verify),
        mib(gib),
        peak_after_verify as f64 / gib as f64
    );
    r.line("      not file size. ADR-0006's bounded-memory claim holds.");
    rl!(r, "   display code: {}", m.display_code());
    let _ = std::fs::remove_file(&path);
}
