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

Profile ladder — **DRAFTED, AND SUPERSEDED BY THE MEASURED SECTION BELOW.**
Every rung shipped as P8, not P2/P4: colour survives a bad camera, resolution does not.
Read "Revised after S4" before using this table.

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

## Revised after S4 (2026-08-22) — geometry enabled
The S1 amendment above ("raise the L0 floor well above 20px/1-bit") was measured
**without perspective warp** and is withdrawn. With realistic hand-held geometry:

| camera | S1 (no warp) | S4 (warp) | drop |
|---|---|---|---|
| good    | P8 @ 6px = 21,405 B | P8 @ 8px = 8,748 B | −59.1% |
| webcam  | P8 @ 8px = 11,781 B | P8 @ 8px = 8,748 B | −25.7% |
| potato  | P2 @ 8px = 3,927 B  | P8 @ 20px = 1,182 B | −69.9% |

**The L0 rung moves to 20px.** The hand-held potato still decodes P8 @ 20px cleanly —
1,182 B/frame, 17.7 KB/s at 15 FPS. It completes, just slowly, which is exactly the
guarantee this ADR exists to make.

Note P8 (3 bits, full colour) wins at every rung, including the potato's. The drafted
assumption that a bad camera needs a 1-bit black-and-white layer is **not supported by
any measurement**; colour survives, resolution does not. A P2 rung may still be worth
keeping as a floor below L0, but it is no longer the potato's operating point.

Rungs must be read from `artifacts/s4-frontier.csv`, never interpolated (see
ADR-0002's measured fiducial cost and the aliasing finding in S1/S2).

## Simulator contract: sensor vs pose
S4 kept `good()`/`webcam()`/`potato()` free of geometry and added
`good_handheld()`/`webcam_handheld()`/`potato_handheld()`. This split is deliberate and
is now the contract, guarded by a test: **base presets model the sensor** (blur, noise,
resolution, chroma, gain); **`_handheld` variants add pose** (yaw, pitch, roll, scale,
translation, barrel, tear). Keeping them separable is what lets a spike attribute a
regression to optics or to framing rather than guessing.

## Alternatives rejected
- **Single fixed profile** — either too slow for good cameras or broken on bad ones.
- **Sender-side ladder sweep** (send a burst at each profile in turn) — works, but
  wastes the whole airtime of every profile the receiver cannot use, where
  interleaving lets good receivers harvest continuously.
- **Human-typed profile selection only** — usable as an optimisation, but it makes
  the bad-camera case a support problem rather than a design property.
