# Chunking is not about speed: gzip, BLAKE3, and a code you can type

> **Status: in progress.** This is spike S5. `crates/core/src/pipeline.rs` is
> written and [`artifacts/s5-pipeline.txt`](../../artifacts/s5-pipeline.txt) has
> measured output, but [`PLAN.md`](../spikes/PLAN.md) still lists S5 as PENDING
> and `LOG.md` has no S5 row. Crucially, the pipeline currently integrates against
> `StubFountain` — a deliberate test double — not the real RaptorQ encoder. The
> seam is designed; it is not yet wired.

If you want to send a file, compress it and send it. One gzip stream over the
whole file gives the best possible ratio, because the deflate dictionary keeps
growing and never resets.

[ADR-0006](../adr/0006-chunked-gzip.md) does not do that, and the reason has
nothing to do with compression speed.

## The failure mode of whole-file coding

Run one fountain over one gzip stream covering the whole file. Coded blocks arrive
out of order. Now ask: what can the receiver *do* with 90% of them?

Nothing. Not "90% of the file" — nothing. A fountain yields
**nothing → nothing → nothing → complete**. And because the blocks are out of
order, you cannot stream-decompress either: gzip is sequential, and you do not
have byte 0 until you have everything.

So the receiver sits at 0% usable for the entire transfer, holds the whole thing
in memory because it cannot write anything out, and if the transfer dies at 70%
you have **zero bytes**. On an optical link that a person has to physically hold
steady, "dies partway" is not an edge case.

## The fix: make the chunk the unit of everything

Split the file into fixed 256 KB chunks. Gzip **each one independently**. Run a
**separate fountain per chunk**.

```
   file
   ├── chunk 0 ──gzip──> fountain 0 ──> endless packets ──┐
   ├── chunk 1 ──gzip──> fountain 1 ──> endless packets ──┼──> frames
   ├── chunk 2 ──gzip──> fountain 2 ──> endless packets ──┘
   └── ...

   each chunk completes ON ITS OWN, is verified ON ITS OWN,
   and is written straight to its byte offset in the output
```

Every property that mattered falls out at once:

- **Real progress.** `bytes_written()` reports plaintext bytes durably on disk —
  the honest number, not "packets received".
- **Bounded memory.** Peak is one chunk plus one gzip member, regardless of file
  size. Measured: **2.8 MB peak RSS for an 8 MB file**, and the manifest costs
  44 bytes per chunk (1,408 bytes for 32 chunks; 176 KB for a 1 GB transfer).
- **Streaming decompression is back.** Chunk N decompresses while chunk N+1 is
  still arriving. Compression is off the critical path and can never stall the
  optical link.
- **Resume is per-chunk**, which is what makes the typed code possible at all.
- **Dies at 70% → you keep 70%.**

## What chunking actually costs

ADR-0006 estimated 1–3% worse compression from the dictionary resets. S5 measured
it across four corpora:

| corpus | 64 KB chunks | 256 KB chunks | 1024 KB chunks |
|---|---|---|---|
| text (prose) | 11.02% | **2.93%** | 0.66% |
| source (rust-like) | 10.25% | **2.62%** | 0.59% |
| repo (real .rs/.md) | 3.59% | 0.00% | 0.00% |
| blob (incompressible) | −0.02% | −0.02% | −0.02% |

Worst compressible-corpus penalty at the 256 KB default: **2.93%**. The estimate
is confirmed — and the table also shows why 256 KB and not 64 KB. At 64 KB the
penalty quadruples. The default sits at the knee.

## The probe: decide once, up front

Deflating an mp4 is pure waste. `probe()` test-compresses the **first chunk only**
and, if the ratio is worse than 0.95, switches the *whole transfer* to raw and
sets a flag. Measured ratios: text 0.359, source 0.281, an mp4/jpg/zip blob 1.000.

The saving is not subtle. On 64 MB of incompressible data: gzip-everything takes
0.80 s (and makes the file 0.02% *bigger*); probe-only takes 3.2 ms. **249× less
CPU**, extrapolating to ~12.8 s per GB of pointless work avoided.

Note "once, up front" — never per chunk. A mixed transfer would need a per-chunk
encoding flag in every frame header for no measurable gain.

## BLAKE3 twice, at two granularities

Per chunk, `ChunkMeta.hash` is BLAKE3 of the **plaintext**, not the stored bytes.
The comment explains why, and it is the good kind of reasoning: a chunk already
sitting in the output file can be re-verified on resume without re-fetching it.
That is what makes "keep 70%" *checkable* rather than merely asserted. A corrupted
gzip member still fails, either at inflate or at this hash.

Per file, `Manifest.file_hash` is BLAKE3 of the whole plaintext, streamed back out
through the sink one chunk at a time — bounded memory even for verification.

That whole-file hash becomes `display_code()`: **30 bits in 6 Crockford base32
characters**, rendered on both screens for a human to compare. Collision odds ~1
in 1.07 × 10⁹. [ADR-0005](../adr/0005-no-backchannel-human-integer.md) argues this
is stronger than any ACK scheme, with zero protocol — and it is right, because an
ACK proves a packet arrived while a hash comparison proves the *file* is correct.

## The resume code

`<chunk>-<need><check>`, all Crockford base32:

- `chunk` — 1–4 chars (4 chars covers 1,048,575 chunks = 256 GB at 256 KB)
- `need` — 1–3 chars (3 chars covers 32,767 outstanding packets)
- `check` — 1 char, 5 bits of BLAKE3 over the two numbers, rejecting ~97% of typos

Total 4–9 characters; a 1 GB transfer is at most 8 and typically 6–7. The measured
example from S5 is **`P-AM2`** — five characters to resume an 8 MB transfer killed
at 68.8%, after which all 22 retained chunks were re-verified against their
manifest hashes and only the remaining 10 were re-sent.

Crockford specifically, and the code says why: no `U` (avoids accidental
obscenities), and `O`/`I`/`L` decode to `0`/`1`/`1` because a human is reading this
off a screen at arm's length.

## Interop, checked

Both sides speak standard RFC 1952 gzip members — one member per chunk, deflate
level 6 (which is what `CompressionStream('gzip')` uses). Verified out of band on
Node v24.18: a `flate2` member → `DecompressionStream('gzip')` and back, 300,000 B
byte-identical each way. The browser build of
[ADR-0007](../adr/0007-rust-core-wasm-browser-only.md) can read and write this wire
format unchanged.

## Rejected

- **Whole-file gzip + one fountain** — simplest, best ratio, no partial progress,
  no resume, unbounded memory.
- **zstd** — better ratio and faster, but browsers ship `CompressionStream('gzip')`
  natively as a real streaming transform. zstd means shipping a WASM blob for
  ~10–15% ratio. Revisit only if the ratio ever matters more than the simplicity.
