//! S5 — the chunking + integrity layer of ADR-0006.
//!
//! Split the payload into fixed chunks (256 KB default), gzip each **independently**,
//! and describe the whole transfer with a manifest. Each chunk is an autonomous unit:
//! it is fountain-coded on its own (ADR-0004), verified on its own, and written into
//! its own byte offset in the output the moment it completes (ADR-0008). A transfer
//! that dies at 70% keeps 70%.
//!
//! Purity (ADR-0009): nothing here touches the filesystem, a camera, or a clock. The
//! sender reads through [`ByteSource`] and the receiver writes through [`RandomSink`],
//! so the same code drives an in-memory sink in tests and an OPFS sync access handle
//! (or a seekable `File`) in production.
//!
//! Compression is `flate2` here because this crate must run natively for tests. The
//! browser build (ADR-0007) substitutes `CompressionStream('gzip')`. Both sides speak
//! **standard RFC 1952 gzip members** — one member per chunk, default deflate level —
//! so a payload produced here is readable by `DecompressionStream('gzip')` and vice
//! versa. Do not switch to raw deflate or a custom container.

use blake3::Hasher;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};

/// ADR-0006 default. Big enough that the dictionary reset costs little, small enough
/// that a chunk is a meaningful unit of progress and of memory.
pub const DEFAULT_CHUNK_SIZE: usize = 256 * 1024;

/// ADR-0006: "if the first chunk's compression ratio is worse than ~0.95 the whole
/// transfer switches to raw". Ratio is `compressed / plain`, so lower is better.
pub const PROBE_RATIO_THRESHOLD: f64 = 0.95;

/// Deflate level. 6 is `Compression::default()` and is what `CompressionStream('gzip')`
/// uses in Chromium/Firefox, which keeps native and browser output comparable.
pub const DEFAULT_LEVEL: u32 = 6;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub chunk_size: usize,
    pub probe_threshold: f64,
    pub level: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            chunk_size: DEFAULT_CHUNK_SIZE,
            probe_threshold: PROBE_RATIO_THRESHOLD,
            level: DEFAULT_LEVEL,
        }
    }
}

impl Config {
    pub fn with_chunk_size(mut self, n: usize) -> Self {
        assert!(n > 0, "chunk size must be positive");
        self.chunk_size = n;
        self
    }
}

/// How every chunk of this transfer is carried on the wire. Decided once, up front,
/// by the probe — never per chunk (a mixed transfer would need a per-chunk flag in
/// every frame header for no measurable gain).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Raw,
    Gzip,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Raw => "raw",
            Encoding::Gzip => "gzip",
        }
    }
}

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

/// One standard gzip member (RFC 1952) per chunk — `DecompressionStream('gzip')`-compatible.
pub fn gzip(plain: &[u8], level: u32) -> Vec<u8> {
    let mut enc = GzEncoder::new(
        Vec::with_capacity(plain.len() / 2 + 64),
        Compression::new(level),
    );
    enc.write_all(plain).expect("vec write cannot fail");
    enc.finish().expect("vec write cannot fail")
}

pub fn gunzip(stored: &[u8], expect_len: usize) -> Result<Vec<u8>, PipelineError> {
    let mut out = Vec::with_capacity(expect_len);
    GzDecoder::new(stored)
        .read_to_end(&mut out)
        .map_err(|_| PipelineError::Inflate)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct Probe {
    pub ratio: f64,
    pub encoding: Encoding,
    pub probed_bytes: usize,
}

/// Test-compress the first chunk only. mp4/jpg/zip come back at ~1.00 and the whole
/// transfer switches to raw, which skips deflate on every remaining chunk.
pub fn probe(first_chunk: &[u8], cfg: &Config) -> Probe {
    if first_chunk.is_empty() {
        return Probe {
            ratio: 1.0,
            encoding: Encoding::Raw,
            probed_bytes: 0,
        };
    }
    let ratio = gzip(first_chunk, cfg.level).len() as f64 / first_chunk.len() as f64;
    let encoding = if ratio < cfg.probe_threshold {
        Encoding::Gzip
    } else {
        Encoding::Raw
    };
    Probe {
        ratio,
        encoding,
        probed_bytes: first_chunk.len(),
    }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkMeta {
    pub index: u32,
    /// Plaintext length of this chunk (== chunk_size except for the last one).
    pub plain_len: u32,
    /// Length actually transmitted: gzip member length, or plain_len when raw.
    pub stored_len: u32,
    /// BLAKE3 of the **plaintext** chunk. Hashing the plaintext rather than the
    /// stored bytes means a chunk already sitting in the output file can be
    /// re-verified on resume without re-fetching it — which is what makes the
    /// "keep 70%" claim of ADR-0006 checkable rather than merely asserted. A
    /// corrupted gzip member still fails, either at inflate or at this hash.
    pub hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub total_size: u64,
    pub chunk_size: u32,
    pub chunk_count: u32,
    pub encoding: Encoding,
    pub chunks: Vec<ChunkMeta>,
    /// BLAKE3 of the whole plaintext file.
    pub file_hash: [u8; 32],
}

impl Manifest {
    pub fn chunk_offset(&self, index: usize) -> u64 {
        index as u64 * self.chunk_size as u64
    }

    pub fn stored_total(&self) -> u64 {
        self.chunks.iter().map(|c| c.stored_len as u64).sum()
    }

    /// The 6-character code the human compares across both screens (ADR-0005).
    /// 30 bits of the whole-file BLAKE3 in Crockford base32.
    pub fn display_code(&self) -> String {
        display_code(&self.file_hash)
    }
}

/// 6 Crockford-base32 chars = 30 bits of hash. Collision odds ~1 in 1.07e9 — far
/// beyond what a human comparing two screens needs, and short enough to actually read.
pub fn display_code(hash: &[u8; 32]) -> String {
    let v = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) >> 2; // top 30 bits
    let mut s = String::with_capacity(6);
    for i in (0..6).rev() {
        s.push(CROCKFORD[((v >> (i * 5)) & 31) as usize] as char);
    }
    s
}

// ---------------------------------------------------------------------------
// source / sink
// ---------------------------------------------------------------------------

/// Sender-side random-access read. `File` implements this in the spike bin; a slice
/// implements it in tests. Deliberately not `std::io::Read`: the core must never own
/// a cursor, and the browser side is an OPFS handle, not a stream.
pub trait ByteSource {
    fn total_len(&self) -> u64;
    /// Fill `buf` from `offset`; returns bytes read (short only at EOF).
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize;
}

impl ByteSource for &[u8] {
    fn total_len(&self) -> u64 {
        self.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize {
        let start = (offset as usize).min(self.len());
        let n = buf.len().min(self.len() - start);
        buf[..n].copy_from_slice(&self[start..start + n]);
        n
    }
}

/// Receiver-side random-access write — the ADR-0008 OPFS
/// `handle.write(chunk, { at: byteOffset })` shape. Chunks land in whatever order the
/// optical channel delivers them, so this is never an append.
pub trait RandomSink {
    fn write_at(&mut self, offset: u64, data: &[u8]);
    /// Read back for verification (resume, final whole-file hash).
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize;
    fn set_len(&mut self, len: u64);
}

/// A sparse in-memory sink: only the byte ranges actually written exist. Models the
/// out-of-order random-access write without pretending a transfer is an append, and
/// without allocating the output up front.
#[derive(Default, Debug)]
pub struct SparseSink {
    pages: std::collections::BTreeMap<u64, Vec<u8>>,
    page: usize,
    len: u64,
}

impl SparseSink {
    pub const PAGE: usize = 64 * 1024;

    pub fn new() -> Self {
        Self {
            pages: Default::default(),
            page: Self::PAGE,
            len: 0,
        }
    }

    /// Bytes physically held — the memory the sink actually costs.
    pub fn resident_bytes(&self) -> usize {
        self.pages.len() * self.page
    }

    pub fn to_vec(&mut self) -> Vec<u8> {
        let mut out = vec![0u8; self.len as usize];
        let n = self.read_at(0, &mut out);
        out.truncate(n);
        out
    }
}

impl RandomSink for SparseSink {
    fn write_at(&mut self, offset: u64, data: &[u8]) {
        let page = self.page;
        let mut off = offset;
        let mut rest = data;
        while !rest.is_empty() {
            let pid = off / page as u64;
            let inner = (off % page as u64) as usize;
            let n = rest.len().min(page - inner);
            let buf = self.pages.entry(pid).or_insert_with(|| vec![0u8; page]);
            buf[inner..inner + n].copy_from_slice(&rest[..n]);
            off += n as u64;
            rest = &rest[n..];
        }
        self.len = self.len.max(offset + data.len() as u64);
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> usize {
        let page = self.page;
        let want = buf.len().min(self.len.saturating_sub(offset) as usize);
        let mut done = 0usize;
        while done < want {
            let off = offset + done as u64;
            let pid = off / page as u64;
            let inner = (off % page as u64) as usize;
            let n = (want - done).min(page - inner);
            match self.pages.get(&pid) {
                Some(p) => buf[done..done + n].copy_from_slice(&p[inner..inner + n]),
                None => buf[done..done + n].fill(0),
            }
            done += n;
        }
        want
    }

    fn set_len(&mut self, len: u64) {
        self.len = len;
    }
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipelineError {
    UnknownChunk,
    WrongLength,
    Inflate,
    HashMismatch,
    BadResumeCode,
    FileHashMismatch,
}

// ---------------------------------------------------------------------------
// sender
// ---------------------------------------------------------------------------

/// Builds the manifest in a single streaming pass and re-materialises any chunk's
/// wire payload on demand. Peak memory is one chunk plus one gzip member — the
/// manifest itself is 44 bytes per chunk (176 KB for a 1 GB transfer at 256 KB).
pub struct Encoder<S: ByteSource> {
    src: S,
    cfg: Config,
    manifest: Manifest,
    probe: Probe,
}

impl<S: ByteSource> Encoder<S> {
    pub fn build(mut src: S, cfg: Config) -> Self {
        let total = src.total_len();
        let chunk_size = cfg.chunk_size;
        let count = total.div_ceil(chunk_size as u64) as usize;

        let mut buf = vec![0u8; chunk_size];

        // Probe on the first chunk only (ADR-0006).
        let first = if count > 0 {
            src.read_at(0, &mut buf)
        } else {
            0
        };
        let probe = probe(&buf[..first], &cfg);

        let mut chunks = Vec::with_capacity(count);
        let mut file_hasher = Hasher::new();
        for i in 0..count {
            let n = if i == 0 {
                first
            } else {
                src.read_at(i as u64 * chunk_size as u64, &mut buf)
            };
            let plain = &buf[..n];
            file_hasher.update(plain);
            let stored_len = match probe.encoding {
                Encoding::Raw => n,
                Encoding::Gzip => gzip(plain, cfg.level).len(),
            };
            chunks.push(ChunkMeta {
                index: i as u32,
                plain_len: n as u32,
                stored_len: stored_len as u32,
                hash: *blake3::hash(plain).as_bytes(),
            });
        }

        let manifest = Manifest {
            total_size: total,
            chunk_size: chunk_size as u32,
            chunk_count: count as u32,
            encoding: probe.encoding,
            chunks,
            file_hash: *file_hasher.finalize().as_bytes(),
        };
        Self {
            src,
            cfg,
            manifest,
            probe,
        }
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn probe_result(&self) -> Probe {
        self.probe
    }

    /// The bytes that go on the wire for chunk `index` — i.e. what the fountain
    /// encodes. One chunk of memory, regardless of file size.
    pub fn chunk_payload(&mut self, index: usize) -> Result<Vec<u8>, PipelineError> {
        let meta = self
            .manifest
            .chunks
            .get(index)
            .ok_or(PipelineError::UnknownChunk)?;
        let mut buf = vec![0u8; meta.plain_len as usize];
        let n = self
            .src
            .read_at(self.manifest.chunk_offset(index), &mut buf);
        buf.truncate(n);
        Ok(match self.manifest.encoding {
            Encoding::Raw => buf,
            Encoding::Gzip => gzip(&buf, self.cfg.level),
        })
    }
}

// ---------------------------------------------------------------------------
// receiver
// ---------------------------------------------------------------------------

/// Accepts chunks in arbitrary order and writes each into its correct offset the
/// moment it completes and verifies (ADR-0006 + ADR-0008).
pub struct Receiver<K: RandomSink> {
    manifest: Manifest,
    sink: K,
    done: Vec<bool>,
}

impl<K: RandomSink> Receiver<K> {
    pub fn new(manifest: Manifest, mut sink: K) -> Self {
        sink.set_len(manifest.total_size);
        let done = vec![false; manifest.chunk_count as usize];
        Self {
            manifest,
            sink,
            done,
        }
    }

    /// Rebuild a receiver over a partially-written output. Every chunk below the
    /// resume point is re-read from the sink and re-verified against its manifest
    /// BLAKE3 — nothing is trusted just because bytes are present.
    pub fn resume(
        manifest: Manifest,
        sink: K,
        code: &ResumeCode,
    ) -> Result<(Self, usize), PipelineError> {
        let mut rx = Self::new(manifest, sink);
        let upto = (code.chunk as usize).min(rx.done.len());
        let mut verified = 0usize;
        for i in 0..upto {
            if rx.verify_written(i)? {
                rx.done[i] = true;
                verified += 1;
            }
        }
        Ok((rx, verified))
    }

    /// Re-read chunk `i` out of the sink and check it against the manifest hash.
    pub fn verify_written(&mut self, index: usize) -> Result<bool, PipelineError> {
        let meta = self
            .manifest
            .chunks
            .get(index)
            .ok_or(PipelineError::UnknownChunk)?
            .clone();
        let mut buf = vec![0u8; meta.plain_len as usize];
        let n = self
            .sink
            .read_at(self.manifest.chunk_offset(index), &mut buf);
        if n != buf.len() {
            return Ok(false);
        }
        Ok(*blake3::hash(&buf).as_bytes() == meta.hash)
    }

    /// A completed chunk arrives from the fountain. Verified, then written straight
    /// to its offset — out of order, never appended.
    pub fn accept(&mut self, index: usize, stored: &[u8]) -> Result<(), PipelineError> {
        let meta = self
            .manifest
            .chunks
            .get(index)
            .ok_or(PipelineError::UnknownChunk)?
            .clone();
        if stored.len() != meta.stored_len as usize {
            return Err(PipelineError::WrongLength);
        }
        let plain = match self.manifest.encoding {
            Encoding::Raw => stored.to_vec(),
            Encoding::Gzip => gunzip(stored, meta.plain_len as usize)?,
        };
        if plain.len() != meta.plain_len as usize {
            return Err(PipelineError::WrongLength);
        }
        if *blake3::hash(&plain).as_bytes() != meta.hash {
            return Err(PipelineError::HashMismatch);
        }
        self.sink
            .write_at(self.manifest.chunk_offset(index), &plain);
        self.done[index] = true;
        Ok(())
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn is_done(&self, index: usize) -> bool {
        self.done.get(index).copied().unwrap_or(false)
    }

    pub fn completed_chunks(&self) -> usize {
        self.done.iter().filter(|d| **d).count()
    }

    pub fn is_complete(&self) -> bool {
        self.done.iter().all(|d| *d)
    }

    /// Plaintext bytes durably on disk right now — the honest progress number.
    pub fn bytes_written(&self) -> u64 {
        self.manifest
            .chunks
            .iter()
            .zip(&self.done)
            .filter(|(_, d)| **d)
            .map(|(c, _)| c.plain_len as u64)
            .sum()
    }

    /// Lowest chunk index not yet complete — the resume point.
    pub fn first_missing(&self) -> Option<usize> {
        self.done.iter().position(|d| !*d)
    }

    pub fn missing(&self) -> Vec<usize> {
        self.done
            .iter()
            .enumerate()
            .filter(|(_, d)| !**d)
            .map(|(i, _)| i)
            .collect()
    }

    /// The code the human reads off the receiver's screen (ADR-0005): "chunk N,
    /// need M more". `need` is the fountain's outstanding-packet count for the
    /// chunk currently in flight.
    pub fn resume_code(&self, need: u32) -> ResumeCode {
        ResumeCode {
            chunk: self.first_missing().unwrap_or(self.done.len()) as u32,
            need,
        }
    }

    /// Stream the finished output back through the sink and check the whole-file
    /// BLAKE3. One chunk of memory, whatever the file size.
    pub fn verify_file(&mut self) -> Result<[u8; 32], PipelineError> {
        let mut h = Hasher::new();
        let mut buf = vec![0u8; self.manifest.chunk_size as usize];
        for i in 0..self.manifest.chunk_count as usize {
            let want = self.manifest.chunks[i].plain_len as usize;
            let n = self
                .sink
                .read_at(self.manifest.chunk_offset(i), &mut buf[..want]);
            h.update(&buf[..n]);
        }
        let got = *h.finalize().as_bytes();
        if got != self.manifest.file_hash {
            return Err(PipelineError::FileHashMismatch);
        }
        Ok(got)
    }

    pub fn sink_mut(&mut self) -> &mut K {
        &mut self.sink
    }

    pub fn into_sink(self) -> K {
        self.sink
    }
}

// ---------------------------------------------------------------------------
// resume code (ADR-0005: one short thing a human reads off a screen and types)
// ---------------------------------------------------------------------------

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn crock_decode(c: char) -> Option<u32> {
    let c = c.to_ascii_uppercase();
    // Crockford aliases: O->0, I/L->1.
    let c = match c {
        'O' => '0',
        'I' | 'L' => '1',
        other => other,
    };
    CROCKFORD
        .iter()
        .position(|&x| x as char == c)
        .map(|i| i as u32)
}

fn crock_encode(mut v: u32) -> String {
    if v == 0 {
        return "0".into();
    }
    let mut s = Vec::new();
    while v > 0 {
        s.push(CROCKFORD[(v & 31) as usize]);
        v >>= 5;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

/// "chunk N, need M more" — ADR-0005/ADR-0006.
///
/// Wire format: `<chunk>-<need><check>`, all Crockford base32, uppercase, one
/// trailing check character.
///
/// * `chunk` — 1..4 chars (4 chars covers 1,048,575 chunks = 256 GB at 256 KB).
/// * `need`  — 1..3 chars (3 chars covers 32,767 outstanding packets).
/// * `check` — 1 char, 5 bits of BLAKE3 over the two numbers; rejects ~97% of typos.
///
/// Total **4 to 9 characters**; a 1 GB transfer at 256 KB (4096 chunks) is at most
/// **8** and typically 6–7, e.g. `3F-2MK`. Crockford is used precisely because a
/// human is reading it: no U (avoids obscenities), and O/I/L decode to 0/1/1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResumeCode {
    pub chunk: u32,
    pub need: u32,
}

impl ResumeCode {
    pub fn new(chunk: u32, need: u32) -> Self {
        Self { chunk, need }
    }

    fn check_char(chunk: u32, need: u32) -> char {
        let mut h = Hasher::new();
        h.update(&chunk.to_be_bytes());
        h.update(&need.to_be_bytes());
        CROCKFORD[(h.finalize().as_bytes()[0] & 31) as usize] as char
    }

    pub fn encode(&self) -> String {
        format!(
            "{}-{}{}",
            crock_encode(self.chunk),
            crock_encode(self.need),
            Self::check_char(self.chunk, self.need)
        )
    }

    /// Parse what the human typed. Case-insensitive; spaces are ignored.
    pub fn decode(s: &str) -> Result<Self, PipelineError> {
        let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let (a, b) = cleaned
            .split_once('-')
            .ok_or(PipelineError::BadResumeCode)?;
        if a.is_empty() || b.len() < 2 {
            return Err(PipelineError::BadResumeCode);
        }
        let mut chunk = 0u32;
        for c in a.chars() {
            let d = crock_decode(c).ok_or(PipelineError::BadResumeCode)?;
            chunk = chunk
                .checked_mul(32)
                .and_then(|v| v.checked_add(d))
                .ok_or(PipelineError::BadResumeCode)?;
        }
        let (digits, check) = b.split_at(b.len() - 1);
        let mut need = 0u32;
        for c in digits.chars() {
            let d = crock_decode(c).ok_or(PipelineError::BadResumeCode)?;
            need = need
                .checked_mul(32)
                .and_then(|v| v.checked_add(d))
                .ok_or(PipelineError::BadResumeCode)?;
        }
        if check.chars().next().map(|c| c.to_ascii_uppercase())
            != Some(Self::check_char(chunk, need))
        {
            return Err(PipelineError::BadResumeCode);
        }
        Ok(Self { chunk, need })
    }
}

// ---------------------------------------------------------------------------
// SEAM: the fountain layer (ADR-0004, crates/core/src/fountain.rs) plugs in here.
// ---------------------------------------------------------------------------

/// Turns one chunk payload into an **endless** packet stream. The real RaptorQ
/// encoder from `fountain.rs` implements this; [`StubFountain`] below is the
/// deterministic stand-in this spike tests against so the two layers can be built
/// in parallel and integrated later.
pub trait PacketEmitter {
    /// Never returns `None`: the sender loops forever until the human stops it (ADR-0005).
    fn next_packet(&mut self) -> Vec<u8>;
}

/// Absorbs packets for one chunk until it can rebuild the payload.
pub trait PacketCollector {
    /// Returns the chunk payload once enough packets have landed.
    fn absorb(&mut self, packet: &[u8]) -> Option<Vec<u8>>;
    /// How many more packets are still needed — the integer the human reads (ADR-0005).
    fn needed(&self) -> u32;
}

/// One fountain per chunk (ADR-0006).
pub trait ChunkFountain {
    type Emitter: PacketEmitter;
    type Collector: PacketCollector;
    fn emitter(&self, payload: &[u8]) -> Self::Emitter;
    fn collector(&self, stored_len: usize) -> Self::Collector;
}

/// In-file stub of the fountain seam: a plain round-robin block repeater. Not a
/// fountain code — it has no coding gain and needs every distinct block — which is
/// exactly what makes it a good test double: the pipeline must not depend on any
/// fountain property beyond "packets in, payload out, packet count remaining".
#[derive(Clone, Copy, Debug)]
pub struct StubFountain {
    pub packet_bytes: usize,
}

impl Default for StubFountain {
    fn default() -> Self {
        Self { packet_bytes: 1024 }
    }
}

pub struct StubEmitter {
    blocks: Vec<Vec<u8>>,
    next: usize,
}

impl PacketEmitter for StubEmitter {
    fn next_packet(&mut self) -> Vec<u8> {
        let i = self.next % self.blocks.len().max(1);
        self.next += 1;
        self.blocks.get(i).cloned().unwrap_or_default()
    }
}

pub struct StubCollector {
    parts: Vec<Option<Vec<u8>>>,
    have: usize,
    stored_len: usize,
}

impl PacketCollector for StubCollector {
    fn absorb(&mut self, packet: &[u8]) -> Option<Vec<u8>> {
        if packet.len() < 8 {
            return None;
        }
        let idx = u32::from_be_bytes(packet[0..4].try_into().unwrap()) as usize;
        let total = u32::from_be_bytes(packet[4..8].try_into().unwrap()) as usize;
        if total != self.parts.len() || idx >= self.parts.len() {
            return None;
        }
        if self.parts[idx].is_none() {
            self.parts[idx] = Some(packet[8..].to_vec());
            self.have += 1;
        }
        if self.have == self.parts.len() {
            let mut out = Vec::with_capacity(self.stored_len);
            for p in &self.parts {
                out.extend_from_slice(p.as_ref().unwrap());
            }
            out.truncate(self.stored_len);
            return Some(out);
        }
        None
    }

    fn needed(&self) -> u32 {
        (self.parts.len() - self.have) as u32
    }
}

impl ChunkFountain for StubFountain {
    type Emitter = StubEmitter;
    type Collector = StubCollector;

    fn emitter(&self, payload: &[u8]) -> StubEmitter {
        let n = payload.len().div_ceil(self.packet_bytes).max(1);
        let blocks = (0..n)
            .map(|i| {
                let lo = i * self.packet_bytes;
                let hi = ((i + 1) * self.packet_bytes).min(payload.len());
                let mut p = Vec::with_capacity(8 + self.packet_bytes);
                p.extend_from_slice(&(i as u32).to_be_bytes());
                p.extend_from_slice(&(n as u32).to_be_bytes());
                p.extend_from_slice(payload.get(lo..hi).unwrap_or(&[]));
                p
            })
            .collect();
        StubEmitter { blocks, next: 0 }
    }

    fn collector(&self, stored_len: usize) -> StubCollector {
        let n = stored_len.div_ceil(self.packet_bytes).max(1);
        StubCollector {
            parts: vec![None; n],
            have: 0,
            stored_len,
        }
    }
}
