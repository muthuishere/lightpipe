# ADR-0009: Pure core + a channel simulator; hardware last

Status: Accepted · 2026-08-22

## Context
Manual testing of an optical link means two devices, a room, and a human holding
things still. That loop is far too slow to develop against, and it is not
reproducible, so regressions are invisible.

## Decision
The core is a **pure function**: `bytes → Vec<RgbImage>` and `Vec<RgbImage> → bytes`.
No camera, no DOM, no canvas, no file I/O anywhere inside it.

A **channel simulator** in the same crate stands in for "screen → air → webcam":

```
encode(bytes) → frames → [ CHANNEL SIM ] → frames' → decode() → bytes
                             │
       perspective warp (misalignment) · gaussian blur (defocus)
       4:2:0 chroma subsample          · per-channel gain + gamma (WB drift)
       sensor noise + JPEG artifacts   · vignette / glare gradient
       frame drops + rolling-shutter tear
```

## Consequences
- Round-trip correctness runs in milliseconds, in CI, on every change.
- We can sweep every (cell size × palette × blur × noise) combination and emit a
  symbol-error-rate surface. **That table is the rate ladder** of ADR-0011 — derived
  from data, not from waving a webcam around a room.
- Once real frames exist they are dumped as PNG sequences into `fixtures/` and run
  through the *same* decoder tests. Simulated and real share one code path.
- The browser is left with only `getUserMedia`, `drawImage`, `requestAnimationFrame` —
  the parts that rarely break.
- Risk: the simulator can be wrong. S6 exists to calibrate it against real captures,
  and any divergence is a bug in the simulator, tracked as such.
