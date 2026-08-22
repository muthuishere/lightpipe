# The RGB cube has eight corners, and that is the whole palette

Colour is free density. A black-and-white cell carries 1 bit; an 8-colour cell
carries 3. Triple your throughput by changing nothing but the paint.

Colour is also the most fragile thing in a screen→camera link. Auto white balance
drifts. Display and sensor gamma curves fight. And webcams deliver YUV 4:2:0, so
[chroma is half-resolution in both axes](03-yuv-420-chroma-subsampling.md).

The naive design is to pick 16 perceptually-spaced colours — evenly distributed in
Lab, maximally distinguishable to a human eye. That design fails, and it fails for
a reason worth internalising.

## Why perceptual spacing is the wrong objective

A perceptually-spaced palette optimises for *a human looking at a clean sample*.
Our decoder is not a human and the sample is not clean. What it actually has to do
is: take a smeared, gain-shifted, gamma-bent mean colour and decide which of N
palette entries produced it.

With arbitrary colours that is a 3-D nearest-neighbour search in a space whose
axes have all been independently stretched by the camera. You cannot correct the
stretch without knowing the palette, and you cannot identify the palette entry
without correcting the stretch.

## The decision: every channel is 0 or 255

[ADR-0003](../adr/0003-rgb-cube-corner-palette.md) constrains every palette colour
to a **corner of the RGB cube**. Each of R, G, B is exactly 0 or 255 — nothing in
between, ever.

```
                    WHITE (255,255,255)
        CYAN ┌───────────┐ YELLOW
            /│          /│
   GREEN   ┌───────────┐ │        every palette entry is a vertex
           │ │         │ │        no entry is ever on an edge or a face
           │ └─────────│─┘ MAGENTA
           │/          │/
   BLACK   └───────────┘ RED
                    BLUE
```

Two properties fall out, and they are the entire argument.

**1. Each channel is one binary question.** If red is only ever 0 or 255, then
recovering the red bit is a single threshold, independent of green and blue.
Three planes, three thresholds, done. A 3-D nearest-neighbour search becomes N
independent binary decisions. Better still, each plane can self-tune its own
threshold from the calibration strip, absorbing per-channel gain drift without
any cross-channel model.

**2. Every symbol lands on a distinct luma level.** Luma is
`0.299R + 0.587G + 0.114B`, and on the cube corners that gives eight distinct
values. Luma is the channel 4:2:0 keeps at full resolution. So a cell whose colour
has been smeared into mush is *still* partially recoverable from brightness alone.
That is a free fallback layer, and it is what makes the graceful degradation of
[ADR-0011](../adr/0011-layered-rate-ladder-bad-cameras.md) possible at all.

## P4: the default

`P4 = BLACK, RED, CYAN, WHITE` — 2 bits per cell.

| symbol | RGB | luma |
|---|---|---|
| BLACK | (0,0,0) | 0.000 |
| RED | (255,0,0) | 0.299 |
| CYAN | (0,255,255) | 0.701 |
| WHITE | (255,255,255) | 1.000 |

Four luma levels, evenly spread about 0.30 apart — the widest possible spacing for
four levels. And red↔cyan are exact chroma opposites: maximum separation in the
chroma plane *as well as* in luma. P4 is not a subset picked for convenience; it
is the specific 4-corner subset that is maximally separated in both planes at once.

## P8 is opt-in, and the reason is blue

`P8` uses all eight corners, 3 bits per cell. It is riskier for two reasons stated
in the ADR: blue sits at luma 0.114, uncomfortably close to black's 0.000, so the
luma fallback loses its evenness; and cameras clip saturated red and blue hardest.
Hence P8 is gated on calibration quality rather than being the default.

The S1 sweep then went and complicated the story. Under the simulated *potato*
camera, P8 at 14 px decodes with SER = 0 — full 3-bit colour surviving heavy blur,
0.42 resample, 4:2:0 and hard MJPEG — while P2 (pure black/white) at 8 px does not
([`s1-sweep.csv`](../../artifacts/s1-sweep.csv)). Bits per cell is simply not the
axis that determines whether a bad camera can read you.
[Cell size is](08-cell-grid-aliasing.md).

## A wrinkle in the implementation

The ADR's argument is "N independent binary thresholds, not a 3-D
nearest-neighbour search". `crates/core/src/palette.rs` does not currently do
that. `Palette::nearest` runs an actual nearest-neighbour loop over the reference
palette, with a distance of `2·Δluma² + 0.5·(ΔR² + ΔG² + ΔB²)` — luma-weighted
nearest-neighbour rather than per-channel thresholding.

That is a deliberate-looking choice (it bakes the luma fallback directly into the
metric, which is elegant) but it is *not* the decoder the ADR describes, and the
independent-threshold speed argument is therefore not yet cashed in. The
cube-corner constraint still buys everything else: the distinct luma levels are
real, and the calibration-derived reference is what the metric measures against.
Recorded here as a divergence between doc and code, not as a defect.

## Rejected

- **Arbitrary perceptually-spaced palettes** — lose the independent-threshold
  property, and force a full 3-D correction model.
- **Grayscale only** — throws away a working 1.5×–2× density for no robustness
  gain once a calibration strip exists.

Next: [YUV 4:2:0](03-yuv-420-chroma-subsampling.md) — the camera constraint that
forced all of this.
