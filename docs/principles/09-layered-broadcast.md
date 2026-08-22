# Broadcasting to a camera you cannot ask about

Rate adaptation is a solved problem when you have a return path. Send, measure
loss, adjust. Wi-Fi does it. Video streaming does it. Every adaptive system on
your machine does it.

We deleted the return path
([ADR-0005](../adr/0005-no-backchannel-human-integer.md)), and the requirement did
not go away: **a bad camera must still get the file through.** Cheap webcams,
fixed focus, aggressive MJPEG, poor low-light response, low resolution and hunting
auto-exposure are normal, not exceptional.

So the sender cannot be told how bad the receiver's camera is, and must nonetheless
serve it.

## Why a single fixed profile cannot work

Pick small, dense cells: a phone reads them at 300 KB/s and a cheap webcam gets
nothing, forever, with no way to say so.

Pick large, robust cells: everything works, and a phone that could have run 6×
faster crawls.

There is no single point on that curve that is acceptable, because the population
of receivers is bimodal and you cannot observe which one you have.

## The alternative that looks obvious and is worse

Sweep it. Send a burst at profile L0, then L1, then L2, then L3, and repeat. Every
receiver eventually sees something it can read.

[ADR-0011](../adr/0011-layered-rate-ladder-bad-cameras.md) rejects this, and the
reason is precise: it **wastes the whole airtime of every profile the receiver
cannot use.** A good camera sitting through the L0 burst harvests nothing from it,
because L0 is a different broadcast carrying different bytes.

## Layered broadcast

Interleave the profiles into one continuous stream. Every receiver harvests blocks
from whichever layers it can decode, continuously, and simply ignores the rest.

```
   stream:  L0  L1  L2  L3  L1  L2  L3  L2  L3  L3  L0  L1 ...

   phone       ↓   ↓   ↓   ↓   ↓   ↓   ↓   ↓   ↓   ↓   ↓   ↓    harvests all
   webcam      ↓   ↓   ↓   ·   ↓   ↓   ·   ↓   ·   ·   ↓   ↓    harvests L0-L2
   potato      ↓   ·   ·   ·   ·   ·   ·   ·   ·   ·   ↓   ·    harvests L0

   no handshake. nothing to negotiate. the good camera never waits.
```

Handshake-free, negotiation-free. A good camera decodes every layer and finishes
fast. A potato decodes only the coarse layer and finishes slowly — but it
**finishes**. Degradation is in *time*, never in success.

Weighting the interleave (say 1 part L0 : 2 L1 : 4 L2 : 8 L3) tunes the tax the
good receivers pay, and the optional human-typed rate digit can drop layers the
receiver clearly does not need.

## Why this only works because of fountain codes

This is the part that makes the whole architecture click into place.

A layer is not a separate transmission of separate bytes. Every layer emits coded
packets for the *same* chunk, from the same
[fountain](01-fountain-codes-raptorq.md). Because the fountain is rateless and any
K + ε packets suffice **in any order from any source**, a receiver can mix packets
harvested from L0, L1 and L2 in whatever proportion its camera allows. Packets are
interchangeable. Nothing has to be tracked, matched, or reconciled.

Try to build this with a fixed-rate code and you would need per-layer bookkeeping,
per-layer completion, and a way for the receiver to tell the sender which layers it
is using. Ratelessness is what collapses all of it.

The [luma fallback](02-rgb-cube-corner-palette.md) is the second free ingredient:
because every palette symbol lands on a distinct luma level, a receiver whose
chroma is unusable can keep decoding at reduced bits per cell instead of dropping
the layer entirely. And frame drops are already free, since a failed CRC is just
[an erasure](04-crc32-and-erasure-semantics.md).

## The ladder was drafted wrong, and the sweep said so

ADR-0011 drafted this ladder:

| profile | cell px | palette | bits/cell | intended reader |
|---|---|---|---|---|
| L0 "bulletproof" | ~20 | P2 | 1 | any camera that can focus |
| L1 "safe" | ~14 | P4 | 2 | cheap webcam |
| L2 "normal" | ~10 | P4 | 2 | decent webcam |
| L3 "fast" | ~8 | P8 | 3 | good webcam / phone |
| L4 "max" | ~6 | P8 | 3 | phone, well lit, steady |

Then S1 measured it, and the ADR was amended in place with a "Measured" section.
The simulated potato decodes **P8 @ 14 px with SER 0** — full 3-bit colour
surviving heavy blur, 0.42 resample, 4:2:0 and hard MJPEG. The drafted L0 floor of
20 px at 1 bit was far too conservative.

Note what that means: **bits per cell was not the binding constraint. Cell size
was.** The intuition that a bad camera needs fewer colours is wrong; it needs
bigger cells, and can have all eight colours once the cells are big enough.

The second amendment is sharper: rungs must be read off the sweep CSV, **never
interpolated**, because SER is non-monotonic in cell size. That is
[its own story](08-cell-grid-aliasing.md), and it means the ladder is a lookup
table, not a formula.

## Acceptance criteria, and where they stand

ADR-0011 wrote binding requirements into the spikes:

- **S1 must include a potato profile** and show at least one layer decoding
  cleanly under it. ✅ Done — currently P8 @ 14 px at 3,645 B/frame, per the
  regenerated [`s1-sweep.csv`](../../artifacts/s1-sweep.csv).
- **S3 must prove end-to-end completion under the potato profile**, measuring only
  how much longer it takes. ✅ Done — the potato layer completes at every drop rate
  up to 70%. A 1 MB chunk is 268 frames / 17.9 s clean and 883 frames / 58.9 s at
  70% loss, at 15 FPS. It is 3.0× slower than the P8 layer at 0% loss. Slower,
  never a failure.
- **A camera so bad that not even L0 decodes must fail loudly and immediately**
  ("cannot see the code — move closer / clean the lens"), never hang at 0%. This
  is partially in place at the geometry layer: `geometry::rectify` returns `None`
  when the fiducials cannot be found, which is the loud failure. The user-facing
  message is an S8 concern and **not yet built**.
- **The interleaved multi-layer broadcast itself is not yet implemented.** The
  ladder data exists; the scheduler that weaves layers into one stream does not
  appear in `crates/core/` yet.

## Rejected

- **Single fixed profile** — too slow for good cameras or broken on bad ones.
- **Sender-side ladder sweep** — works, but wastes the airtime of every profile the
  receiver cannot use.
- **Human-typed profile selection only** — fine as an optimisation, but it turns
  the bad-camera case into a support problem rather than a design property.

The cost, honestly stated: the receiver must run several decoders per captured
frame, one per layer geometry. That is the main CPU expense and the reason SIMD
cell sampling matters.
