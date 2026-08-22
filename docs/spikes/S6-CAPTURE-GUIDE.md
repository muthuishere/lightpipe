# S6 — capturing real fixtures (the human-in-the-loop spike)

Everything through S5 was measured against a **simulator**. S6 exists to answer one
question: **how wrong is the simulator?** Any divergence between simulated and real
symbol-error-rate is a bug in `sim.rs`, tracked as such (ADR-0009) — not an excuse.

You need: two devices, a room, ten minutes. No code.

---

## 1. Generate the target frames

```bash
task spike:0          # writes artifacts/s0-frame.png  (P4 @ 10px, canonical)
task spike:4          # writes artifacts/s4-warped.png and s4-rectified.png
```

Display `artifacts/s0-frame.png` **at exact 1:1 pixel scale**, full screen, no
scaling and no browser zoom. Scaling resamples the grid and you would be measuring
your image viewer instead of the channel.

- macOS Preview: View → Actual Size (⌘0), then full screen.
- Turn **off** Night Shift / f.lux / any blue-light filter — it is a global colour
  cast and it will wreck the calibration strip.
- Set the display to a fixed brightness. Auto-brightness is a slow gain drift the
  decoder has no way to know about.

## 2. Capture

Three sets, roughly 30 frames each. Name the directories exactly:

| directory | how |
|---|---|
| `fixtures/tripod-good/` | phone on a stand or propped up, screen filling ~80% of frame, steady, room lit |
| `fixtures/handheld-webcam/` | laptop webcam, handheld or propped, whatever angle is natural |
| `fixtures/potato/` | the worst camera you own, poor light, slightly off-axis — an old phone, a cheap USB webcam |

Save as PNG or lossless-quality JPEG. **Do not crop, rotate, colour-correct, or
"enhance"** — every one of those hides exactly what we are trying to measure.

Also record, in `fixtures/<dir>/NOTES.md`:
- device and camera (model if you know it)
- approximate distance, and the angle if it is obviously off-axis
- lighting (daylight / lamp / dim)
- whether autofocus was hunting

That metadata is what makes a divergence diagnosable rather than mysterious.

## 3. What happens next

The same decoder that runs against the simulator runs against these PNGs — one code
path, no special case (ADR-0009). We then compare, per fixture set:

| | simulated | real | divergence |
|---|---|---|---|
| symbol error rate | from `artifacts/s1-sweep.csv` | measured | ← the number that matters |
| fiducial detection rms (px) | S4: 0.88 / 1.05 / 1.43 | measured | |
| frames dropped by CRC | | | |

**Expected divergences, and what each would mean:**
- **Real is worse than simulated** — the simulator is too kind. Most likely suspects:
  MJPEG artifacts (ours is a crude 8×8 block-mean stand-in, not a real DCT),
  auto-exposure hunting (not modelled at all), and screen moiré (not modelled).
- **Real is better than simulated** — the `potato()` preset is pessimistic and the
  rate ladder is leaving throughput on the table.
- **Fiducials fail entirely** — the marker is too small for real optics; `geometry.rs`
  sizes it at `8·cell` clamped to [72, 96] px and that clamp is a guess.

## 4. Honest caveat

Two things are **not** in the simulator at all yet and cannot be caught by static
captures — they need live video:

- **Frame tearing** from unsynchronised screen refresh and camera shutter. LightSync
  found frame sync alone nearly doubles throughput, so this is likely the single
  largest remaining unknown in the project.
- **Auto-exposure and autofocus hunting** against a changing image.

A static PNG capture cannot show either. S6 measures the *optical* channel; the
*temporal* channel is still unmeasured, and no number in this repo covers it.
