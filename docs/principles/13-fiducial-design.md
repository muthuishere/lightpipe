# Four bullseyes: designing a marker a bad camera can find

> **Status: in progress.** This is spike S4, listed PENDING in
> [`PLAN.md`](../spikes/PLAN.md); `crates/core/src/geometry.rs` is under active
> edit. Constants below are current as read but may move.

[Recovering the grid](05-homography-and-perspective-correction.md) needs four
point correspondences. Getting four points from an image sounds trivial until you
write down what the marker actually has to survive.

It must be findable when the image is blurred (σ = 2.0 px), resampled to 42% and
back, chroma-subsampled, block-compressed, noisy, vignetted at the corners where
the markers live, gamma-bent, and perspective-warped. It must be locatable to
**sub-pixel** accuracy, because a one-pixel error in a corner propagates through
the homography into a misaligned grid at the far side of the frame. And it must
never be confused with payload — a false marker is worse than no marker, because
it produces a confident wrong homography rather than a clean failure.

## Why not a solid square

The first instinct is a solid black square in each corner. It fails immediately:
**a solid black square is indistinguishable from a run of black payload cells.**
Payload is pseudorandom, and in a frame of 30,000 cells, runs of adjacent black
cells that form roughly square blobs are not rare — they are guaranteed.

You need a signature that payload cannot produce by accident.

## The bullseye

Concentric squares, 6 units on a side:

```
   +---------------+   outer black ring   (1 unit thick)
   | +-----------+ |   white ring         (1 unit thick)
   | | +-------+ | |   black centre dot   (2 units)
   | | |       | | |
   | | +-------+ | |   ...surrounded by a white quiet zone
   | +-----------+ |      filling the rest of the corner margin
   +---------------+
```

Black → white → black, nested. To produce that by accident, payload would have to
generate a black region, containing a white region, containing a black region, at
the right relative scales, in a corner. The verifier checks it with **17 probes**:
the centre, plus four radii × four directions, at 0.167 / 0.500 / 0.833 / 1.167 of
the half-width — centre dot, white ring, black ring, quiet zone. `VERIFY_THRESHOLD`
requires 78% agreement.

There is a second gate that is easy to miss and is the good part: the verifier also
checks that the mean luma of the probes expected dark is at least 30 below the mean
of those expected light. Shape alone is not enough — the rings must actually be
*separated in brightness*. A payload region that happens to have the right topology
but low contrast is rejected.

## Black and white, no colour at all

The markers use only `BLACK` and `WHITE` — the two extreme
[luma levels](02-rgb-cube-corner-palette.md), 0.00 and 1.00.

The source notes this gives **3.3× the luma separation of the closest pair of P8
payload colours**, and needs no chroma whatsoever. Since
[4:2:0 halves chroma resolution in both axes](03-yuv-420-chroma-subsampling.md),
building the one component that everything else depends on out of the
full-resolution channel only is the obviously correct call. If the markers fail,
nothing decodes; they should not share a failure mode with the payload they are
there to locate.

## Sub-pixel by construction

The centre estimate is the **centroid of the black blob**, accumulated as
`sx / area`, not the centre of its bounding box.

Centroids are affine-covariant: rotation, scale and translation leave the estimate
exact, and only the (small) perspective term biases it. And because blur is
symmetric, blurring a symmetric shape does not move its centroid — the marker
degrades in sharpness without degrading in position. That is precisely the property
you want from something that must be accurate under defocus.

Measured accuracy from [`s4-frontier.csv`](../../artifacts/s4-frontier.csv):
0.55–0.94 px RMS for `good+warp` and `webcam+warp`, 1.27–2.34 px for
`potato+warp`. Sub-pixel on the two better cameras, through the full degradation
chain.

## Finding the blobs

`adaptive_black_mask` is worth calling out. A global threshold would fail
immediately — the markers sit in the corners, which is exactly where
[vignetting](06-channel-simulation-as-methodology.md) is strongest, so a corner
marker's "white" can be darker than the centre's "black".

Instead a pixel is black when it sits `bias = 8` below the **local** mean of a box
around it, computed from an integral image so it costs O(1) per pixel regardless of
window size. Because vignette and gain drift are low-frequency and the window is
small, they cancel out entirely. The window radius is `marker_size / 3` clamped to
[8, min(w,h)/4] — sized so one marker-third spans the black ring and the white
either side, small enough not to drown in the dark frame border.

Candidates are then filtered on area, minimum dimension, aspect ratio (0.5–2.0),
and **fill ratio 0.20–0.85** — a ring fills about 5/9 of its bounding box while a
solid blob fills nearly 1, so this single test discards solid payload runs before
the expensive probe check runs at all.

Finally `detect_fiducials` keeps only candidates scoring within 0.07 of the best
score, rather than applying a fixed threshold. The reasoning in the source is
sound: a real marker always scores at or near the top, so a *relative* band drops
accidental ring-shaped payload blobs without a fixed floor that a bad camera could
fall below.

## What it costs

Markers live entirely in the frame margin — `stamp_fiducials` touches no payload
cell. But the margin has to grow to hold them, and that is where the real price is.

`marker_size(cell) = (8 × cell).clamp(72, 96)`, `quiet_zone = marker_size / 6`, and
`margin_for(cell) = marker_size + 2 × quiet_zone`. Against the plain
`FrameSpec::new` margin of one cell, that is a large increase.

Comparing S1 (margin = cell) with S4 (margin = `margin_for`) at 1920×1080:

| layer | S1 B/frame | S4 B/frame | cost |
|---|---|---|---|
| P8 @ 8 px | 11,602 | 8,992 | −22.5% |
| P8 @ 10 px | 7,338 | 5,482 | −25.3% |
| P8 @ 14 px | 3,645 | 2,499 | −31.4% |

Roughly a quarter of the payload area, and proportionally more at large cell sizes
because the marker is clamped at 96 px and stops scaling with the cell. Being able
to find the grid from a hand-held camera is not cheap — but the alternative is
requiring the user to align the frame perfectly, which is not a product.

## Doc/code divergence

The module doc says the marker is "**≥ 48 px, or 6 cells**, whichever is bigger".
The code says `(8 * cell).clamp(72, 96)` — 8 cells, floored at 72 px. Neither
number in the prose matches the constant beneath it. This file is mid-edit, so this
is most likely a stale comment rather than a bug, but it should be reconciled
before S4 closes.

Also unresolved by design: corner roles are assigned from the extremes of `x+y`
and `x−y`, which is unambiguous only up to **±45° of in-plane rotation**. Past
that, the four-fold symmetry of the marker set needs an asymmetric marker to break
it. ADR-0002 leaves that for when a use case demands it.
