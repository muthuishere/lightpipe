# ADR-0014: Always chunk and always gzip. No raw mode, no probe.

Status: Accepted · 2026-08-22
Supersedes the compressibility-probe portion of ADR-0006.

## Context
ADR-0006 specified a compressibility probe: test-compress the first chunk, and if the
ratio is worse than ~0.95 (mp4, jpg, zip), switch the whole transfer to raw and set a
flag in the manifest. S5 measured the probe saving **258× CPU** — 3.1 ms to probe
versus 0.80 s to gzip 64 MB — and ~12.8 s per GB.

That saving was measured against **nothing**. It compares gzip CPU to zero, not to the
thing gzip CPU actually has to keep up with.

## The number that was missed
The e2e integration measured the encoder at **79.7 MB/s** and the optical channel at
**131 KB/s** (webcam) down to **17.6 KB/s** (potato). The compressor is between
**600× and 4,500× faster than the channel it feeds.**

Compression was never on the critical path. ADR-0006 already requires per-chunk
streaming compression, so chunk N+1 compresses while chunk N is on the screen — there
is not even a startup stall to amortise. The probe optimised a resource with three
orders of magnitude of headroom, and bought a branch, a manifest flag, and two code
paths with it.

## Decision
**Always chunk. Always gzip. Every chunk, every transfer, no exceptions.**
No probe, no raw mode, no ratio threshold, no conditional.

The manifest's `compressed` field stays (the wasm/JS contract is frozen and the field
is cheap) but is now invariably `true`. Treat it as reserved, not as a branch.

## Consequences
- **One code path.** No probe, no flag to get wrong, no "why did this transfer pick raw"
  class of bug, and nothing to test in two configurations.
- Incompressible input (mp4, jpg, zip) gets **0.02% larger** — gzip framing overhead on
  data it cannot shrink. On a 128 KB blob that is 26 bytes. Against a channel that
  drops 26% of its bits to fiducials (ADR-0002) and loses whole frames to CRC, 0.02% is
  not a number worth branching for.
- Encoder CPU rises on incompressible input. Given 600×–4,500× headroom, it does not
  become the bottleneck. **Decoder CPU is the layer under real pressure** — see the e2e
  measurements — and decompression of incompressible data is nearly free, so this
  decision does not touch the constrained side.

## What would reverse this
If a target device is ever found where gzip encode drops below ~5× the optical rate —
a very slow phone, or a much faster channel — the probe comes back. Measure before
reintroducing it; do not assume.
