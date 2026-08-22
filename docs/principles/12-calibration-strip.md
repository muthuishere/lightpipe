# One row of known colours: calibration against gamma and white balance

You paint pure red — `(255, 0, 0)`. The camera reports `(233, 18, 9)`.

Nothing is broken. Between your framebuffer and the decoder's array sit the
display's gamma curve and colour profile, the ambient light, the sensor's spectral
response, the camera's auto white balance, its auto exposure, its own gamma
encoding, and JPEG's colour handling. Each one is a transform you do not control
and cannot query.

Worse, they **drift mid-transfer**. Auto white balance hunts. Auto exposure
reacts. The transform that mapped red to `(233, 18, 9)` in frame 1 maps it
somewhere else in frame 200.

Hard-coded thresholds cannot survive this. So the frame carries its own reference.

## Row 0 is not payload

`FrameSpec::CALIB_ROWS = 1`. The very top grid row of every frame is a
**calibration strip**: every palette colour, cycling across the width.

```
   row 0  [K][R][C][W][K][R][C][W][K][R][C][W] ...   <- known ground truth
   row 1  [ header band: the 25-byte record, repeated ]
   row 2  [                                          ]
   row 3+ [ payload cells                            ]
```

At 238 columns and P4, that is roughly 59 samples of each colour, in every single
frame.

The decoder's first act is `measure_reference`: for each palette symbol, take the
mean observed colour across every calibration cell that carries it. The result is
the *measured* palette — what red actually looks like through this display, this
lens, this sensor, right now, in this frame.

Symbols are then classified against the measured palette, not the ideal one. The
entire response chain — gamma, gain, exposure, whatever — is cancelled, because
both the reference and the payload went through it together.

## Why per-frame rather than once

This is the design choice that matters. Calibrating once at the start would be
cheaper and would be wrong, because the transform is not constant. A per-frame
reference tracks a hunting auto-exposure and a drifting white balance with zero
protocol and zero state: each frame is self-describing.

It also means a frame is decodable **in isolation**. That matters enormously for
the [layered broadcast](09-layered-broadcast.md), where a receiver may harvest one
frame from a layer, skip four, and take another — there is no per-layer calibration
state to maintain, and no warm-up period after switching.

## Cost

One grid row. At 1920×1080 with P4 at 8 px cells that is 238 cells of 30,940 — about
0.77% of the frame, or 59 bytes. Compare that with what it buys: total immunity to
a class of failure that would otherwise need a hand-tuned threshold per camera
model.

Combined with the 2-row header band, the non-payload overhead is 3 rows out of 133.

## The RGB cube corners make it cheap

`measure_reference` returns one mean colour per symbol, and that is sufficient
*because* every palette entry is a
[cube corner](02-rgb-cube-corner-palette.md). Each channel is only ever fully on
or fully off, so measuring the palette is measuring the endpoints of each channel's
response. There is no curve to fit and no interpolation to do — with an arbitrary
palette you would be trying to reconstruct a 3-D nonlinear map from scattered
samples.

The fallback path is careful: if a symbol has no calibration samples at all (a very
narrow frame), `measure_reference` substitutes the ideal colour for that entry
rather than producing a degenerate reference.

## What is built and what is not

ADR-0011 specifies **per-frame colour correction** as "a 3×3 matrix fitted from the
calibration strip each frame". What `modem.rs` currently implements is one step
short of that: a per-symbol mean reference, with `Palette::nearest` measuring
distance against it using `2·Δluma² + 0.5·(ΔR² + ΔG² + ΔB²)`.

That handles per-channel gain and gamma, which is the dominant effect. It does not
handle **channel cross-talk** — a full 3×3 matrix would also correct for the
sensor's colour filter array bleeding green response into red. Fitting one from
the same strip is straightforward (four or eight known colour pairs is more than
enough to least-squares a 3×3) but it is **not yet implemented**.

Two related notes on the same code path:

- [ADR-0003](../adr/0003-rgb-cube-corner-palette.md) argues the decoder should be
  N independent per-channel thresholds, each self-tuning from the calibration
  strip. The implementation is a nearest-neighbour search instead. It works, and
  the luma weighting bakes in the fallback elegantly, but it is not the decoder
  the ADR describes.
- The luma weighting (2× on luma, 0.5× on raw channel distance) is the graceful
  degradation of [4:2:0](03-yuv-420-chroma-subsampling.md) made concrete: when
  chroma is smeared, the full-resolution brightness channel dominates the decision
  automatically. There is no separate "luma fallback mode" to switch into — it is
  continuous, and it is one line of the distance metric.

## Sampling inset

A companion trick lives in `FrameSpec::sample_rect`: sampling uses only the inner
region of each cell, inset by `cell / 4` on each side. A 8 px cell is sampled over
its middle 4×4.

Blur and resampling smear colour across cell boundaries, so the outer ring of every
cell is contaminated by its neighbours. Discarding half the linear dimension of the
cell costs you 75% of the available samples and buys a dramatically cleaner mean.
That is a good trade when the enemy is bias rather than variance — averaging more
contaminated pixels does not help, it just gives you a more confident wrong answer.
