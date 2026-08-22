# Bigger cells are not always better: grid aliasing, and how a header band cost us a rung

Everyone's intuition about optical codes is the same, and it is wrong.

The intuition: symbol error rate decreases monotonically with cell size. Bigger
cells are more pixels, more pixels is more signal, more signal is fewer errors.
Pick the smallest cell that meets your error budget and you are done — and since
the curve is monotonic, you can find that point by bisection, or interpolate
between two measurements.

Every part of that is false on a real sampling chain, and the project has the CSV
to prove it.

## The measurement

[`artifacts/s1-sweep.csv`](../../artifacts/s1-sweep.csv), simulated potato camera,
P2 (pure black and white — one bit, the most robust modulation available):

| cell px | 6 | 8 | 10 | 14 | 20 |
|---|---|---|---|---|---|
| SER | 2.7e-1 | **1.6e-4** | **6.0e-3** | 0 | 0 |

Read the 8 px and 10 px columns again. **Growing the cell from 8 px to 10 px made
the error rate 37× worse.** The same inversion shows up at P4 (5.5e-2 → 8.7e-2)
and at P8 (8.6e-2 → 1.5e-1). It is not noise in one cell of the sweep; it is the
whole column.

## Why

Two regular grids are being multiplied together.

Grid one is yours: the cell pitch, in screen pixels. Grid two is the camera's:
`Channel::potato()` has `resample: 0.42`, meaning the sensor sees the 1920×1080
screen at 42% of its resolution, then that gets scaled back up. Add 4:2:0 chroma
siting and 8×8 JPEG blocks and there are several periodic grids in the chain.

When two periodic structures overlap, what matters is not their absolute sizes but
their **ratio** — specifically, how close that ratio is to a simple fraction.

```
   cell pitch 8 px, resample 0.42  ->  8 x 0.42 = 3.36 sensor px per cell
   cell pitch 10 px, resample 0.42 -> 10 x 0.42 = 4.20 sensor px per cell

   3.36 : phase drifts fast across the row; each cell's sampling offset
          differs from its neighbour's, errors are decorrelated and rare

   4.20 : very nearly 4.2 = 21/5, a short repeat. Phase locks into a
          5-cell cycle, so the SAME cells in every cycle land badly
          on the boundary -- and they do it consistently, everywhere
```

A near-rational ratio produces a *beat pattern*: certain cells consistently land
straddling a sensor-pixel boundary, and no amount of averaging inside those cells
helps, because the error is systematic rather than random. A messier ratio spreads
the phase around and averages the damage away.

This is the same phenomenon as moiré on a photographed screen, or wagon wheels
turning backwards on film. It is not a bug in anyone's code. It is what happens
when you sample a periodic signal with a periodic sampler.

The practical consequence is stated in
[ADR-0011](../adr/0011-layered-rate-ladder-bad-cameras.md) as a rule:

> Rungs must be read off the sweep CSV, not interpolated: SER is **non-monotonic**
> in cell size because cell pitch aliases against the sensor's resample grid.

You cannot bisect. You cannot interpolate. You measure every rung you intend to
ship, and you ship only measured rungs.

## And then it bit us for real

S1 finished, the ladder was drafted from the sweep, and the potato camera's best
clean rung was P2 at 8 px — SER exactly 0, 3,927 B/frame.

Then S2 added frame integrity: a 25-byte header record in a band of
`HEADER_ROWS = 2` grid rows, sitting between the calibration strip and the
payload. A completely orthogonal change. It touches integrity, not optics. It
costs 1.5–2.7% of frame capacity and nothing else.

Except that the payload region now starts **two cell-rows lower**.

Every payload cell moved down by `2 × cell` pixels. The cell grid's *phase*
against the sensor's resample grid shifted. And the sweep changed:

- Before: potato P2 @ 8 px, **SER 0**, 3,927 B/frame.
- After: potato P2 @ 8 px, **SER 1.6e-4**, 3,867 B/frame.

The 60-byte capacity drop is arithmetic — two rows of 238 cells at 1 bit each. The
SER change is not arithmetic. It is the grid landing in a different place.

Meanwhile every 14 px and 20 px rung stayed clean. The ladder did not degrade
uniformly; it lost one specific rung while its neighbours were untouched, which is
exactly the signature of a phase effect rather than a signal-strength effect.

From [`LOG.md`](../spikes/LOG.md):

> the 2-row band re-phased the cell grid against the sensor resample grid — potato
> P2@8px fell off SER 0 (1.6e-4) while 14/20px stayed clean, so s1-sweep.csv had
> to be regenerated. **Layout changes invalidate the rate ladder.**

## The rule this produces

**Any change to frame layout invalidates the ladder, and the sweep must be
re-run.** Not re-derived, not adjusted, not interpolated. Re-run.

That includes changes that look purely logical: adding a header row, widening the
margin for [fiducials](13-fiducial-design.md), moving the calibration strip,
changing the sampling inset. None of them are "just capacity". All of them move
the grid.

It is an uncomfortable rule because it makes frame layout a
performance-critical interface rather than a bookkeeping detail. It is also the
only rule consistent with the data.

## A live inconsistency worth flagging

The S1 section of [`PLAN.md`](../spikes/PLAN.md) still records the potato camera's
best clean layer as **P2 @ 8px, 3,927 B/frame**. Those are the *pre-header*
numbers. The regenerated `s1-sweep.csv` in `artifacts/` no longer agrees: P2 @ 8px
is 3,867 B at SER 1.6e-4, and the best clean potato rung is now **P8 @ 14px at
3,645 B/frame**. S2's own write-up notes the shift, but the S1 summary table was
never updated to match its own CSV. S3's capacity column (3,927 B) inherits the
stale figure too — harmless there, since S3 measured overhead per packet and
overhead is capacity-independent, but it is the same stale number travelling
downstream.

Which is, if anything, the lesson restated: this is exactly how a re-phased grid
propagates into documents if nobody re-runs the sweep.

Related: [YUV 4:2:0](03-yuv-420-chroma-subsampling.md) (the other sampling-grid
effect) · [the rate ladder](09-layered-broadcast.md) (what the CSV is *for*).
