# ADR-0006: Chunk first, gzip per chunk, one fountain per chunk

Status: Accepted · 2026-08-22

## Context
A single gzip stream over the whole file compresses best. But a fountain code over
the whole file yields **nothing → nothing → nothing → complete**: blocks arrive out
of order, so you cannot stream-decompress, and the receiver sits at 0% usable until
the final block lands. A transfer that dies at 70% yields zero bytes.

## Decision
Split the file into fixed chunks (256 KB default), gzip each **independently**, and
run a **separate fountain per chunk**.

Compression happens once, up front — never inside the frame loop. If the first
chunk's compression ratio is worse than ~0.95 (mp4, jpg, zip), the whole transfer
switches to raw and sets a flag.

## Consequences
- Each chunk completes and is written to disk on its own: real progress, bounded
  memory, and a 4 GB file never touches the heap.
- The receiver decompresses chunk N while chunk N+1 is still arriving — compression
  is off the critical path and never stalls the optical link.
- Resume is per-chunk. The human-typed code (ADR-0005) becomes "chunk 12, need 340".
- Dies at 70% → you keep 70%.
- Cost: ~1–3% worse compression ratio at 256 KB, because the dictionary resets.

## Alternatives rejected
- **Whole-file gzip + one fountain** — simplest and best ratio, but no partial
  progress, no resume, unbounded memory.
- **zstd** — better ratio and faster, but browsers ship `CompressionStream('gzip')`
  natively as a real streaming transform. zstd means shipping a WASM blob for
  ~10–15% ratio. Revisit if we ever need the ratio more than the simplicity.
