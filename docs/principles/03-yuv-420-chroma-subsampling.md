# Your webcam throws away three quarters of the colour before you ever see it

Here is a fact that quietly destroys most colour-barcode designs: the camera does
not hand you RGB. It hands you YUV 4:2:0, and in 4:2:0 the two colour-difference
planes are stored at **half resolution in both axes**.

Luma — brightness — is full resolution. Chroma is one sample per 2×2 pixel block.
Three quarters of the colour information is gone at the sensor's output stage,
before any code you write gets a chance to look at it.

```
   luma plane (full res)          chroma planes (half res, both axes)

   Y Y Y Y Y Y                    C   C   C
   Y Y Y Y Y Y                      (one Cb and one Cr sample
   Y Y Y Y Y Y                    C   C   C   per 2x2 luma block)
   Y Y Y Y Y Y
   Y Y Y Y Y Y                    C   C   C
   Y Y Y Y Y Y
```

This is not a cheap-webcam problem. It is the default output format of essentially
every USB webcam, every phone camera pipeline, and every MJPEG/H.264 stream. It is
also not something you can opt out of from a browser.

## What that does to a 6-pixel cell

Do the arithmetic that [ADR-0003](../adr/0003-rgb-cube-corner-palette.md) does.

A 6 px cell, at half chroma resolution in both axes, covers 3×3 = 9 chroma
samples… if it is perfectly aligned. It never is. The chroma grid is fixed to the
sensor; your cell grid is wherever the screen happens to land. Once you factor in
that a real camera is also resampling (a 480p sensor looking at a 1080p screen
scales by ~0.45) and that the sampler is inset to avoid neighbour bleed, the
effective count drops toward **~1.5 chroma samples per cell** — the figure the ADR
quotes.

One and a half samples. And each of those samples is a *box average* of a 2×2
region that straddles the cell boundary, so it is contaminated by the neighbouring
cells' colours.

Now imagine a 16-colour perceptually-spaced palette on that cell. The palette's
whole premise is that you can distinguish 16 chroma positions. You are trying to
resolve 16 positions from one and a half heavily-averaged, boundary-contaminated
samples. It falls apart — at exactly the small cell sizes you wanted colour for in
the first place. That is the trap: colour promises density, density means small
cells, and small cells are where chroma dies.

## The two conclusions that shaped the format

**Fewer, more extreme colours.** If chroma has 1.5 samples of budget, spend it on
the largest possible separations. The RGB cube corners are the extreme points of
the space — you cannot be further apart than fully-on versus fully-off. P4 goes
further and picks red↔cyan, which are exact chroma opposites. Under a box average
that mixes a red cell with a cyan neighbour, the result lands near grey, which is
maximally distant from *both* — the error is detectable rather than a silent slide
into the adjacent symbol.

**Make luma carry the message too.** Luma is the plane 4:2:0 leaves alone. Because
every cube corner has a distinct luma value, the palette is simultaneously a
brightness code. When the chroma planes are unusable, decoding continues on
brightness alone at reduced bits per cell. That is not a fallback bolted on
afterwards; it is a consequence of the palette constraint, and it is the mechanism
[layered broadcast](09-layered-broadcast.md) leans on.

The same reasoning drives the [fiducial design](13-fiducial-design.md): the corner
markers are pure black and white, the two extreme luma levels, and use **no chroma
at all**. `crates/core/src/geometry.rs` notes that this gives 3.3× the luma
separation of the closest pair of P8 payload colours.

## Simulating it honestly

`sim.rs::chroma_subsample` does the real transform rather than approximating it:
convert RGB → Y/Cb/Cr with the BT.601 coefficients, box-average Cb and Cr over
each 2×2 block, replicate the average back over the block, convert back to RGB.
Luma is left untouched. Its doc comment calls it "the single most important
degradation for a colour design", and every non-ideal camera preset
(`good`, `webcam`, `potato`) has `chroma_420: true`.

Because it is a real transform and not a fudge factor, the palette decision is
testable: switch it off and the sweep numbers move, which tells you exactly how
much of your margin was chroma.

## What is still unknown

The simulator applies 4:2:0 as a clean box filter on an aligned 2×2 grid. Real
camera pipelines use different chroma siting conventions, may filter before
subsampling, and interleave subsampling with JPEG's own chroma handling. S6 — the
first spike that touches hardware — exists to measure how wrong this is. Any
divergence between simulated and real symbol error rate is treated as a bug in the
simulator, not a surprise about reality
([ADR-0009](../adr/0009-pure-core-and-channel-simulator.md)).

Next: [cell-grid aliasing](08-cell-grid-aliasing.md) — the other sampling-grid
effect, and a much stranger one.
