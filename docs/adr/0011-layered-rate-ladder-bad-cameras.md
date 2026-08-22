# ADR-0011: Layered rate ladder — a bad camera must still complete

Status: Accepted · 2026-08-22

## Context
Requirement: **a bad camera must still get the file through.** Cheap webcams,
fixed focus, aggressive MJPEG compression, poor low-light response, low resolution,
and hunting auto-exposure are all normal, not exceptional.

But we have no back-channel (ADR-0005), so the sender cannot be *told* how bad the
receiver's camera is. Classic rate adaptation is unavailable.

## Decision
**Layered / hierarchical broadcast.** Because fountain codes are rateless (ADR-0004),
the sender interleaves several profiles into one continuous stream, and the receiver
harvests blocks from whichever layers it can decode. There is no handshake and
nothing to negotiate.

Profile ladder (final numbers come from the S1 sweep, not from this document):

| profile | cell px | palette | bits/cell | intended reader |
|---|---|---|---|---|
| L0 "bulletproof" | ~20 | P2 (black/white) | 1 | any camera that can focus at all |
| L1 "safe"        | ~14 | P4 | 2 | cheap webcam |
| L2 "normal"      | ~10 | P4 | 2 | decent webcam |
| L3 "fast"        | ~8  | P8 | 3 | good webcam / phone |
| L4 "max"         | ~6  | P8 | 3 | phone camera, well lit, steady |

A good camera decodes every layer and finishes quickly. A potato webcam decodes only
L0 and finishes slowly — but it **finishes**. Same broadcast serves both.

Supporting degradations, all already implied by earlier ADRs:
- **Luma fallback** — when chroma is unusable, every palette symbol still has a
  distinct luma level (ADR-0003), so decoding continues at reduced bits/cell.
- **Per-frame colour correction** — a 3×3 matrix fitted from the calibration strip
  each frame absorbs white-balance and gamma drift.
- **Frame drops** are already free (ADR-0004).

## Consequences
- Guaranteed completion on any camera that can resolve L0 cells. Degradation is in
  *time*, never in success.
- Cost: a good camera wastes the airtime spent on coarse layers. Mitigate by
  weighting the interleave (e.g. 1 part L0 : 2 L1 : 4 L2 : 8 L3) and by letting the
  optional human-typed rate digit (ADR-0005) drop layers the receiver clearly
  does not need.
- The receiver must run several decoders per captured frame, one per layer geometry.
  This is the main CPU cost and the reason SIMD cell sampling matters.

## Acceptance (binding on the spikes)
- **S1 must include a "potato camera" profile** in its sweep — heavy blur, high
  noise, low resolution, aggressive JPEG, drifting white balance — and demonstrate
  that at least one layer decodes cleanly under it.
- **S3 must prove end-to-end completion** under the potato profile, measuring only
  how much longer it takes.
- A camera so bad that not even L0 decodes must **fail loudly and immediately**
  ("cannot see the code — move closer / clean the lens"), never hang at 0%.

## Measured (S1, 2026-08-22)
The drafted ladder above was conservative. `artifacts/s1-sweep.csv` shows the
simulated potato camera decoding **P8 @ 14px** with SER 0, and **P2 @ 8px** carrying
3,927 B/frame. Two consequences for the ladder, to be applied when S4 lands
(perspective warp will move the frontier):
- The L0 floor should be raised well above the drafted 20px/1-bit.
- Rungs must be read off the sweep CSV, not interpolated: SER is **non-monotonic**
  in cell size because cell pitch aliases against the sensor's resample grid.

## Alternatives rejected
- **Single fixed profile** — either too slow for good cameras or broken on bad ones.
- **Sender-side ladder sweep** (send a burst at each profile in turn) — works, but
  wastes the whole airtime of every profile the receiver cannot use, where
  interleaving lets good receivers harvest continuously.
- **Human-typed profile selection only** — usable as an optimisation, but it makes
  the bad-camera case a support problem rather than a design property.
