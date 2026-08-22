# Principles

Standalone explainers, one per algorithm or technique the project actually uses.
Each opens with the problem, shows why the obvious approach fails, and then how it
is solved here — so a reader who has never seen this repo finishes understanding
the *technique*, not just our use of it.

Rules for this directory:

- **Every number comes from the repo** — [`LOG.md`](../spikes/LOG.md),
  [`PLAN.md`](../spikes/PLAN.md), the CSVs in [`artifacts/`](../../artifacts/), or
  the code. Nothing is invented. "Not yet measured" is written where that is the
  truth.
- **Rejected alternatives are covered too.** The interesting half of every
  [ADR](../adr/) is the option it closed.
- Several published numbers are explicitly **upper bounds**, measured without
  perspective warp or frame tearing. That is flagged where it applies.

## The posts

| # | post | the hook |
|---|---|---|
| 01 | [Fountain codes / RaptorQ](01-fountain-codes-raptorq.md) | The receiver never says *which* blocks it missed, only *how many* — which is why the back-channel collapses to one typed integer. Measured overhead is not a percentage but a one-packet tail bound. |
| 02 | [The RGB-cube-corner palette](02-rgb-cube-corner-palette.md) | Constrain every channel to 0 or 255 and a 3-D nearest-neighbour search becomes N binary thresholds — plus every symbol lands on a distinct luma level, which is a free fallback layer. |
| 03 | [YUV 4:2:0 chroma subsampling](03-yuv-420-chroma-subsampling.md) | Your webcam throws away three quarters of the colour before you see it. A 6 px cell gets ~1.5 chroma samples, which is what kills a naive 16-colour design. |
| 04 | [CRC32 and erasure semantics](04-crc32-and-erasure-semantics.md) | A fountain decoder tolerates missing equations perfectly and lying equations not at all — so a frame is dropped whole. False-accept rate measured at 0 / 101,000. |
| 05 | [Homography and perspective correction](05-homography-and-perspective-correction.md) | The screen is flat, so four points pin the map exactly — and the lens term nobody has left to estimate is recovered from the cell grid's own Fisher ratio. |
| 06 | [Channel simulation as a test methodology](06-channel-simulation-as-methodology.md) | A pure core plus a simulated camera let five spikes run with no hardware, in milliseconds, in CI. The `potato` preset is binding, not aspirational. |
| 07 | [Chunked gzip, BLAKE3, and resume codes](07-chunked-gzip-blake3-resume.md) | Chunking is about partial progress and streaming decompression, not speed. Whole-file coding yields nothing → nothing → nothing → complete. |
| 08 | [Cell-grid aliasing](08-cell-grid-aliasing.md) | Symbol error rate is **non-monotonic** in cell size — and adding a 2-row header re-phased the grid and silently cost a ladder rung. The best story in the project. |
| 09 | [Layered / hierarchical broadcast](09-layered-broadcast.md) | You cannot negotiate a rate with a camera you cannot ask about — so interleave every profile into one stream and let each receiver harvest what it can. |
| 10 | [Prior art](10-prior-art.md) | PixNet, COBRA, LightSync, JAB Code, HCCB, libcimbar, BC-UR, qrcp — what we took from each and what we left. |
| 11 | [Bit packing](11-bit-packing.md) | 8 does not divide by 3. Forty-nine lines that would corrupt data only at P8 if they were subtly wrong. |
| 12 | [The calibration strip](12-calibration-strip.md) | Auto white balance drifts *mid-transfer*, so every frame carries its own reference row and is decodable in isolation. |
| 13 | [Fiducial design](13-fiducial-design.md) | A solid black square is indistinguishable from payload. A nested black/white/black bullseye is not — and its centroid is sub-pixel by construction. |

## Reading orders

**The optical layer, bottom up:**
[03](03-yuv-420-chroma-subsampling.md) → [02](02-rgb-cube-corner-palette.md) →
[12](12-calibration-strip.md) → [11](11-bit-packing.md) →
[08](08-cell-grid-aliasing.md) → [13](13-fiducial-design.md) →
[05](05-homography-and-perspective-correction.md)

**The protocol, top down:**
[01](01-fountain-codes-raptorq.md) → [04](04-crc32-and-erasure-semantics.md) →
[07](07-chunked-gzip-blake3-resume.md) → [09](09-layered-broadcast.md)

**How any of this was knowable without hardware:**
[06](06-channel-simulation-as-methodology.md) → [08](08-cell-grid-aliasing.md)

## Status of the underlying spikes

S0–S3 are DONE with measured numbers in `LOG.md`. S4 (geometry) and S5 (pipeline)
are **in flight** — code and artifacts exist, `PLAN.md` still marks both PENDING,
and neither has a `LOG.md` row. Posts 05, 07 and 13 carry an in-progress banner and
their numbers will move. S6 (real capture fixtures), S7 (wasm) and S8 (React app)
are not started; nothing in this directory describes real hardware.
