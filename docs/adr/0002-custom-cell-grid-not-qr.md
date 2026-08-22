# ADR-0002: Custom cell grid, not QR codes

Status: Accepted · 2026-08-22

## Context
Animated-QR transfer exists (`txqr`, BC-UR in hardware wallets) but tops out around
10–12 KB/s. QR spends most of its area on finder patterns, timing patterns, format
info and alignment blocks — all designed so a phone can read a crumpled poster at an
angle. We have a flat, self-illuminated screen at a fixed distance.

## Decision
Define our own frame format: four corner fiducials, a calibration strip, a header
band, and the rest payload cells. No QR anywhere in the stack.

## Consequences
- Roughly 3–4x the payload area of a QR of the same size.
- We own geometry detection (homography from fiducials) — see ADR-0009 for how it
  gets tested without hardware.
- No off-the-shelf decoder; anyone reading our frames needs our code.

## Alternatives rejected
- **QR (`txqr`)** — the overhead is the whole point of QR and we need none of it.
- **JAB Code (ISO/IEC 23634:2022)** — a real standardised 8-colour barcode from
  Fraunhofer SIT, LGPL. Excellent palette research (we borrow it, ADR-0003) but it
  is a *static document* symbology, not a streaming channel format.
- **libcimbar** — the practical bar to beat (850 kbit/s, C++/Emscripten). We follow
  its architecture; we do not vendor it, because we need a different runtime and a
  different degradation story (ADR-0011).
