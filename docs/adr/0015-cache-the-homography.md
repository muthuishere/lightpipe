# ADR-0015: The decoder is stateful — cache the homography across frames

Status: Accepted · 2026-08-22

## Context
The e2e integration suggested decode CPU might be the binding constraint on the whole
product (~96 KB/s sustained against a 131 KB/s channel). S7 then profiled the wasm
decoder at 1920×1080 and found the cost is not where it looked:

| stage | ms/frame (wasm) |
|---|---|
| `detect_fiducials` | 8.2 |
| `fit_geometry` (~78 `grid_score` evals, 3 coarse-to-fine lens stages) | 30.6 |
| `warp_with` (warps all ~2M pixels) | 20.1 |
| **`decode_frame`** | **0.5** |
| total decode + rectify | **76.4 → 13.1 FPS** |

**The actual decoding is 0.55 ms — 1,816 FPS, sixty times faster than we need.**
Everything slow is *geometry*, and geometry is being recomputed from scratch on every
single frame as if the camera teleported between exposures.

## Decision
The decoder is **stateful across frames**. It keeps the last good homography and lens
term, and:

1. **Reuses them by default.** Between two frames 33 ms apart, a propped-up or
   hand-held camera has barely moved. The pose from frame N is almost always valid for
   frame N+1.
2. **Re-fits only on evidence** — when `grid_score` degrades past a threshold, or a
   frame fails to decode. Re-fit is the exception, not the rule.
3. **Warps only the cell sample points**, not all ~2M pixels. The decoder needs the
   mean of a small inset region per cell — a few thousand point samples — not a
   rectified image. `warp_with` exists to produce a picture for humans
   (`artifacts/s4-rectified.png`); the decode path does not need one.

Expected steady-state cost: **~1 ms/frame**, from 76 ms.

## Consequences
- Clears 30 FPS with ~30× headroom instead of missing 15 FPS.
- **Decode CPU is not the product's constraint.** The earlier reading was an artifact
  of re-solving a solved problem 30 times a second. The real ceiling returns to the
  optical channel, where S1–S4 always said it was.
- The decoder gains state, so it needs an explicit reset (camera moved, user
  re-aimed, decode stalls) and the stall path must be bounded so a stale homography
  cannot wedge it. A hard re-fit after N consecutive failures.
- First frame still pays the full ~76 ms fit. That is a one-off acquisition cost and
  is the right place to show the user an alignment indicator.
- Fiducial detection (8.2 ms) can be skipped entirely while the cached pose holds,
  since its only consumer is the fit.

## What this does not change
S4's accuracy numbers stand — the homography is essentially exact when it is fitted.
This is purely about *how often* we pay for it.
