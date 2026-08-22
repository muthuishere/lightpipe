# ADR-0007: Rust core compiled to WASM; browser-only runtime

Status: Accepted · 2026-08-22

## Context
Runtime must be browser-only — no install, shareable as a link. The hot path is
per-frame image processing at 30 FPS, so GC pauses and JS-boundary copies matter.
Candidate languages: Go, Zig, Rust.

## Decision
**Rust** core (`crates/core`), pure and I/O-free, compiled to `wasm32-unknown-unknown`
and loaded by a React app.

## Consequences
- We get `raptorq` (a real RFC 6330 implementation), `reed-solomon-simd` and `blake3`
  off the shelf. This is the deciding factor: RFC 6330 RaptorQ is a correctness
  minefield — GF(256) arithmetic, precoding matrices, inactivation decoding — and
  writing it ourselves would be weeks with failures that only show on rare block
  patterns.
- Artifact will be ~200–400 KB rather than Zig's ~50 KB. Acceptable for a web tool;
  mitigate with `opt-level=z` + `wasm-opt` at release.
- The hot path bypasses wasm-bindgen and shares linear memory directly, so camera
  frames are written into WASM with zero copies.

## Measured (S7, 2026-08-22)
- **Bundle: 219.3 KB gzipped** (414 KB raw) at `opt-level=3` + `wasm-opt`. The
  200–400 KB prediction holds, at the bottom of the band.
- **The `opt-level="z"` mitigation stated above is withdrawn.** It buys 18.6 KB
  gzipped (8.5%) and costs 1.2× on decode, 1.9× on frame render, and **2.1× on the
  geometry path** — 76.5 → 161.5 ms/frame, i.e. it doubles the cost of the one path
  that is already the bottleneck (ADR-0015). Ship `opt-level=3`. Revisit only if
  bundle size ever matters more than frame rate.
- **The anti-Go argument is now grounded rather than asserted.** Our JS↔WASM boundary
  costs **0.90 µs/frame** — 0.16% of one frame's decode — and serialises **0 bytes**.
  Zero-copy verified, not assumed: 500 frames grow linear memory by 0 bytes, where a
  copying boundary would have moved 4.0 GiB.
- Aligned decode is **0.55 ms/frame = 1,816 FPS**; sender render 3.36 ms = 297 FPS.
  WASM is nowhere near the constraint.

## Alternatives rejected
- **Go** — ~2 MB minimum WASM (GC + runtime ships with you), `syscall/js` allocates
  on every boundary crossing (fatal at 1080p × 30 FPS), GC pauses inside a realtime
  decode loop, no SIMD. TinyGo shrinks the binary but has stdlib gaps and still no
  good SIMD. Clearly wrong for this workload.
- **Zig** — genuinely strong: `wasm32-freestanding`, no runtime, no GC, ~50 KB
  artifacts, fast compiles, `@Vector` maps cleanly onto wasm128 SIMD, and exported
  linear memory gives zero-copy frames. Rejected **only** because we would have to
  write RaptorQ and Reed–Solomon ourselves. If we ever accept plain LT codes
  (~200 lines) instead of RaptorQ, Zig becomes the better choice — revisit then.
- Note: Rust's compile-speed reputation is a big-dependency-tree problem. This crate
  is small; incremental native test builds are seconds and WASM is built at release
  only. Compile speed was the wrong axis to optimise here.
