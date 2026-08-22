# ADR-0003: Palette is RGB-cube corners; P4 by default

Status: Accepted · 2026-08-22

## Context
Colour multiplies density but is the most fragile part of a screen→camera link:
auto white balance, gamma, display profiles, and — the big one — **webcams deliver
YUV 4:2:0, so chroma is half-resolution in both axes**. A 6 px cell gets ~1.5 chroma
samples. Naive 16-colour palettes fall apart at exactly the cell sizes we want.

## Decision
Every palette colour is a corner of the RGB cube — each channel is exactly 0 or 255.

Default **P4 = black, red, cyan, white** (2 bits/cell). Luma 0.00 / 0.30 / 0.70 / 1.00.
**P8 = all eight corners** (3 bits/cell) is opt-in, gated on calibration quality.

## Consequences
- Decoding is N **independent binary thresholds**, one per channel — not a 3-D
  nearest-neighbour search. Simpler, faster, and each plane self-tunes from the
  calibration strip.
- Every symbol lands on a **distinct luma level**, and luma is the full-resolution
  channel. So a cell whose colour is mush is still partially recoverable from
  brightness alone. This is the free fallback layer that makes ADR-0011 work.
- P4's four luma levels are evenly spread (0.30 apart) and red↔cyan are chroma
  opposites — maximum separation in both planes.
- P8 is riskier: blue sits at luma 0.114, nearly black, and cameras clip saturated
  red and blue hardest. Hence opt-in.

## Alternatives rejected
- **Arbitrary perceptually-spaced palettes** — lose the independent-threshold property.
- **Grayscale only** — throws away a working 1.5x–2x with no robustness gain once
  calibration exists.
