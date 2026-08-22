# Five spikes, zero hardware: channel simulation as a test methodology

The natural way to build a screen-to-camera link is: write some code, put two
laptops on a table, hold one still, squint at the output, change something, repeat.

That loop is about ninety seconds long at best. It is not reproducible — the light
changed, your hand moved, the webcam re-exposed. And because it is not
reproducible, **regressions are invisible**. You cannot tell "this change made it
worse" from "the room got darker".

[ADR-0009](../adr/0009-pure-core-and-channel-simulator.md) refuses that loop
entirely. Five of the eight spikes in this project ran with no camera, no room,
and no human holding anything.

## Part one: the core is a pure function

```
   bytes  ->  Vec<RgbImage>          and          Vec<RgbImage>  ->  bytes
```

No camera, no DOM, no canvas, no filesystem, no clock, no randomness of its own.
`crates/core/src/lib.rs` opens by saying so, and the discipline is real: the file
I/O in the spike binaries lives in `src/bin/`, never in the library. The pipeline
layer goes further and abstracts even the byte source and sink behind
`ByteSource` / `RandomSink` traits, so the same code drives an in-memory sink in
tests and an OPFS handle in the browser.

Purity is what makes the second part possible. If `encode` returns images and
`decode` takes images, then anything that turns images into worse images is a
channel.

## Part two: the channel simulator

`crates/core/src/sim.rs` is one struct with about a dozen knobs and a deterministic
(seeded) PRNG. Each knob models a specific physical thing:

```
   frames  ->  [ CHANNEL SIM ]  ->  frames'

   geometry (S4)   perspective warp: yaw / pitch / roll / scale / translate
                   barrel distortion (single-parameter radial, k < 0)
   readout         rolling-shutter tear: rows above a seam come from the
                   PREVIOUS frame -- applied in image space, after warp,
                   because a tear is a sensor read-out artifact
   response        per-channel gain (white-balance drift) + gamma
   optics          vignette (corner falloff, r² law)
                   gaussian blur (defocus), sigma in pixels
   sensor          resample: downsample to the sensor's real resolution and
                   back up -- the detail lost in between is what a low-res
                   camera actually throws away
   format          YUV 4:2:0 chroma subsampling
                   MJPEG stand-in: lerp each pixel toward its 8x8 block mean
   noise           gaussian sensor noise
```

Order matters and the code gets it right: response and vignette before blur,
blur before resample, resample before chroma subsampling, compression before
noise. That is the order the physical chain applies them in, and shuffling it
would produce a simulator that is wrong in ways no single knob explains.

Two implementation details are worth borrowing.

**The blur is separable.** A 2-D Gaussian factorises into a horizontal pass and a
vertical pass, turning an O(r²) convolution per pixel into O(r). `blur()` builds a
1-D kernel out to 3σ, runs it across rows into a temp buffer, then down columns.
For σ = 2.0 (the potato) that is 13 taps twice instead of 169 — an order of
magnitude, and it is why sweeping the whole (cell × palette × camera) surface
takes seconds.

**The resample is a real round-trip.** `resample_roundtrip` box-averages down to
`factor × resolution` and bilinearly interpolates back up. It does not blur as a
proxy for low resolution. That distinction is exactly what produces the
[cell-grid aliasing](08-cell-grid-aliasing.md) finding — a blur proxy would have
smoothed it away and the whole non-monotonicity would have been invisible.

## Four cameras, and one of them is binding

| preset | blur σ | resample | jpeg | noise | gain | gamma | vignette |
|---|---|---|---|---|---|---|---|
| `ideal` | 0 | 1.00 | 0 | 0 | neutral | 1.00 | 0 |
| `good` | 0.6 | 0.90 | 0.10 | 2 | 1.02/1.00/0.97 | 1.05 | 0.05 |
| `webcam` | 1.1 | 0.70 | 0.25 | 5 | 1.08/1.00/0.90 | 1.15 | 0.15 |
| `potato` | 2.0 | 0.42 | 0.55 | 11 | 1.18/1.00/0.80 | 1.35 | 0.32 |

The `potato` is the point. It is declared binding: some layer must still decode
under it, and a change that breaks it is a **regression**, not a tradeoff. Having
a named worst case in code — rather than "works on my webcam" — is what converts a
vague robustness goal into a test that fails.

## What this bought

- **S1** swept cell size × palette × camera and emitted a symbol-error-rate
  surface. That CSV *is* the rate ladder of
  [ADR-0011](../adr/0011-layered-rate-ladder-bad-cameras.md) — derived from data,
  not from waving a webcam around a room.
- **S2** corrupted 101,000 frames to measure a false-accept rate. You cannot
  corrupt 101,000 real frames.
- **S3** ran 3,600 fountain decodes across eight drop rates.
- **S4** swept warp angles with *ground truth* available — `project_point` gives
  the exact projected fiducial centre, so detection error is measurable in pixels
  rather than eyeballed.
- Round-trip correctness runs in milliseconds, in CI, on every change.

## The honest caveat, stated by the ADR itself

> Risk: the simulator can be wrong.

Several published numbers are explicitly **upper bounds**. The S1 caveat says so:
those numbers were measured with no perspective warp and no frame tearing, and
"will come down". S4 is now supplying the warp, and it does move the frontier —
`potato+warp` loses P4 and P8 at 14 px, which were clean unwarped.

The `jpeg` knob is self-described as crude: an 8×8 block-mean lerp, not a DCT
quantiser. Real JPEG has ringing and its own chroma handling.

S6 exists precisely to calibrate all of this against real captures. The rule it
sets is the one that keeps the method honest: real frames get dumped as PNG
sequences into `fixtures/` and run through the *same* decoder, and any divergence
between simulated and real SER is **a bug in the simulator, tracked as such** —
not a revision of expectations.

Related: [YUV 4:2:0](03-yuv-420-chroma-subsampling.md) ·
[cell-grid aliasing](08-cell-grid-aliasing.md) ·
[homography](05-homography-and-perspective-correction.md).
