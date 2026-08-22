# Finding the grid: homography and perspective correction

> **Status: in progress.** This is spike S4, which
> [`PLAN.md`](../spikes/PLAN.md) still lists as PENDING. The code in
> `crates/core/src/geometry.rs` is real and produces
> [`artifacts/s4-frontier.csv`](../../artifacts/s4-frontier.csv), but the spike is
> mid-flight — `spike4.rs` still carries debug blocks, `LOG.md` has no S4 row, and
> the numbers below will move.

Everything else in this project assumes the decoder knows where cell (12, 7) is.
`modem::sample` walks a fixed lattice: `margin + col × cell`, sample the inset
rectangle, threshold. That works because the encoder and the decoder share a
`FrameSpec`.

A camera does not share your FrameSpec. It sees the screen rotated a few degrees
because nobody holds a laptop level, foreshortened because it is off-axis,
scaled because the screen does not fill the frame, off-centre, and bent outward
because cheap webcam optics are barrel-distorted.

So there is a step before decoding: work out the mapping, undo it, and hand
`modem::sample` an image in canonical geometry so that every S0/S1 result applies
unchanged.

## Why a homography, and why exactly four points

The screen is **flat**. That is the whole reason this is tractable.

Any two views of a plane are related by a *homography* — a 3×3 projective matrix
acting on homogeneous coordinates. Eight degrees of freedom (the ninth is scale,
fixed to 1), which means **four point correspondences determine it exactly**. Not
approximately, not in a least-squares sense: four points, eight equations, one
solution.

This is why the format has four corner fiducials and not three or six. Three would
give an affine map, which cannot represent foreshortening. More than four would
need least squares and would not buy anything as long as the four are accurate.

`Homography::from_points` builds the 8×8 system directly from the four
correspondences and solves it with Gaussian elimination and partial pivoting.
There is no linear-algebra dependency — `solve8` is about thirty lines. For an
8×8 system that is the correct engineering call.

```
   canonical frame            captured image
   +--------------+
   | ●          ● |            ╱●──────────●╲
   |              |    H      │              │
   |              |  ------>   │              │
   | ●          ● |             ╲●──────────●╱
   +--------------+

   four correspondences  ->  8 equations  ->  exactly one H
   H⁻¹ maps every captured pixel back to a canonical one
```

## The part four points cannot do

A homography models a plane seen through a *pinhole*. A real lens also bends
straight lines. `Radial` implements the standard single-parameter model: a point
at normalised radius r is pushed to r(1 + k·r²), with k < 0 for barrel — the usual
webcam sign.

Four fiducials pin the homography **exactly**, so they leave nothing over to
estimate k with. The four corners can always be matched perfectly by *some*
homography regardless of what the lens did to everything between them.

`geometry.rs` recovers k from a genuinely nice trick: the frame's own cell grid.

## Grid score — a Fisher ratio as an alignment oracle

`grid_score` samples 9 taps inside each of many cells (at 0.3, 0.5, 0.7 of the cell
pitch in each axis) and computes the ratio of variance **between** cells to
variance **within** a cell.

When the sampling lattice sits on cell centres, all nine taps inside a cell agree
(within-variance → 0) while different cells disagree (between-variance is the
palette spread). Straddle a cell boundary and both move the other way. So the
ratio peaks exactly when the geometry is right.

The comment in the source makes the key point about why this and not something
simpler: *"Unlike raw contrast this cannot be maximised by an accidentally sharp
but wrong alignment."* Contrast-maximising would happily lock onto an edge. A
Fisher ratio is asking specifically "does this look like a grid of uniform cells",
which is the actual question.

`fit_geometry` then does a three-stage coarse-to-fine search over k —
(±0.20, step 0.010), then (±0.012, step 0.0012), then (±0.0015, step 0.0002) —
maximising the grid score at each stage. The final stage is that fine because, as
the code notes, a 0.001 error in k moves the frame edge by about one pixel.

`K_MAX = 0.20` is a safety bound with a specific reason: beyond |k| = 1/3 the
radial polynomial stops being monotone inside the image and the model folds the
picture onto itself, which produces a *spurious, very high* grid score. The search
is deliberately kept well clear of a region where its own objective function lies.

## What it currently measures

From [`s4-frontier.csv`](../../artifacts/s4-frontier.csv), decoding through the
full pipeline (render → stamp fiducials → warp + lens + all the S1 optical
degradations → rectify → sample), with the three `*_handheld` camera presets:

| camera | clean (SER 0) rungs | fiducial RMS |
|---|---|---|
| `good+warp` (yaw 12°, pitch 8°, roll 6°, scale 0.82, k −0.04) | P2/P4/P8 at 10, 14, 20 px | 0.55–0.88 px |
| `webcam+warp` (yaw 8°, pitch 6°, roll 4°, scale 0.85, k −0.06) | P2/P4/P8 at 8, 10, 14, 20 px | 0.67–0.94 px |
| `potato+warp` (yaw 6°, pitch 5°, roll 3°, scale 0.80, k −0.09) | P2 at 14, 20 px; P4/P8 at 20 px | 1.27–2.34 px |

Sub-pixel fiducial recovery on the two better cameras, and 6 px collapses
everywhere — `fiducial_rms_px = nan` in those rows means detection failed outright
and `rectify` returned `None`, which is the loud failure
[ADR-0011](../adr/0011-layered-rate-ladder-bad-cameras.md) requires rather than a
silent wrong decode.

Note the capacity column: at P8 @ 10 px the warped spec carries 5,482 B/frame
against S1's 7,338 B. The wider margin needed to hold the fiducials costs roughly
a quarter of the payload area. Being able to find the grid is not free.

## Design notes worth stealing

- **The base camera presets stay geometry-free on purpose.** `sim.rs` says so
  explicitly: `roundtrip.rs` asserts SER = 0 for `good()` sampled *without*
  rectification, and any warp there would break it. The warped world lives in
  separate `*_handheld` variants so the S1 ladder and the S4 results stay
  measurable side by side.
- **Corner roles come from extremes of x+y and x−y**, which is unambiguous up to
  ±45° of in-plane rotation. Beyond that the four-fold symmetry needs an
  asymmetric marker; the code says so and defers it.
- **`rectify` returns `Option`.** No fiducials, no decode. Never a guess.

Related: [fiducial design](13-fiducial-design.md) · [channel
simulation](06-channel-simulation-as-methodology.md).
