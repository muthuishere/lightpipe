# lightpipe

Move a file between two devices using **nothing but light**. One screen animates a
grid of coloured cells; the other device's camera reads them. No network, no
Bluetooth, no NFC, no pairing, no cable — at any point.

Not QR. QR spends most of its area on finder patterns, timing patterns and
alignment blocks so a phone can read a crumpled poster at an angle. We have a flat,
self-illuminated screen at a fixed distance, so we use a format built for that
channel instead (ADR-0002).

## Why

The point is the **air gap**, not convenience. Wi-Fi will always be faster. This is
for moving a key, a signed transaction, or a document off a machine where USB is
banned and radio is banned.

If you just want a file off your laptop and onto your phone over Wi-Fi, use
[`qrcp`](https://github.com/claudiodangelis/qrcp). It is excellent and this project
is not trying to replace it.

## How it works

```
   SENDER                          AIR                        RECEIVER
 ┌──────────┐                                              ┌──────────┐
 │  file    │                                              │  file    │
 │    ↓     │   chunk → gzip → fountain → cells → frames   │    ↑     │
 │  screen  │ ═══════════════ photons ═══════════════════> │  camera  │
 └──────────┘                                              └──────────┘
                                                                 │
        "COMPLETE ✓ a7f3c9"  ←── human compares two short codes ─┘
```

- **Chunked** — the file is split, each chunk gzipped and fountain-coded on its own,
  so progress is real, memory is bounded, and a transfer that dies at 70% keeps 70%
  (ADR-0006).
- **Fountain-coded** — the sender emits an endless stream of distinct coded blocks;
  the receiver reconstructs from any N+ε of them, in any order. Lost and torn frames
  are normal, not an error path (ADR-0004).
- **One direction only** — there is no back-channel. Because fountain codes are
  rateless, the receiver never needs to say *which* blocks it missed, only **how
  many more**. That is one small integer a human can read off a screen (ADR-0005).
- **Layered** — coarse and fine profiles are interleaved into one broadcast. A good
  camera decodes every layer and finishes fast; a cheap webcam decodes only the
  coarse layer and finishes slowly, but it **finishes**. Degradation is in time,
  never in success (ADR-0011).

## Testing without hardware

The core is a pure function — `bytes → Vec<RgbImage>` and back. No camera, no DOM,
no I/O. A **channel simulator** stands in for "screen → air → webcam":

```
encode(bytes) → frames → [ CHANNEL SIM ] → frames' → decode() → bytes
                              │
      perspective warp (misalignment) · gaussian blur (defocus)
      4:2:0 chroma subsample          · per-channel gain + gamma (WB drift)
      sensor noise + MJPEG artifacts  · vignette / glare
      frame drops + rolling-shutter tear
```

So the whole system is testable in CI, in milliseconds, with no hardware and no
browser (ADR-0009). Four simulated cameras ship as presets: `ideal`, `good`,
`webcam`, and `potato` — the last one is binding, and a change that breaks it is a
regression rather than a tradeoff.

## Quick start

```bash
task              # show the spike ladder and its status
task test         # every automated test — no hardware, no browser
task ci           # fmt + clippy -D warnings + tests
task spike:0      # cell round-trip on a perfect channel   → artifacts/s0-frame.png
task spike:1      # degraded-channel sweep, incl. potato    → artifacts/s1-sweep.csv
task adr          # list architecture decisions
```

Every spike is runnable by a human and leaves an artifact you can look at without
reading any Rust (ADR-0010).

## Layout

| path | what |
|---|---|
| `crates/core/` | pure Rust core: palette, bit codec, frame geometry, modem, channel simulator |
| `docs/adr/` | every decision that closed an option, and what was rejected |
| `docs/spikes/` | the S0–S8 ladder (`PLAN.md`) and measured results (`LOG.md`) |
| `artifacts/` | generated PNGs and CSVs — the human-inspectable output of each spike |
| `openspec/` | spec-driven change proposals |

## Status

Spike-first (ADR-0010): nothing is built before a spike proves it. See
[`docs/spikes/PLAN.md`](docs/spikes/PLAN.md) for the ladder and the measured numbers.
Nothing before S6 touches hardware; the React app is S8, last.

## Prior art worth reading

- [libcimbar](https://github.com/sz3/libcimbar) — 850 kbit/s with colour-icon-matrix
  barcodes. The practical bar to beat.
- [PixNet](https://www.researchgate.net/publication/220926447_PixNet_Interference-free_wireless_links_using_LCD-camera_pairs) (SIGCOMM '10) — treats screen→camera as a real channel and runs OFDM over it.
- [COBRA](https://dl.acm.org/doi/pdf/10.1145/2307636.2307645) (MobiSys '12) — colour barcode streaming with blur-adaptive block sizing.
- [JAB Code](https://jabcode.org/) — ISO/IEC 23634:2022, Fraunhofer SIT. Standardised 8-colour palette research.
- BC-UR animated QR — actually shipping in air-gapped hardware wallets today.
- [txqr](https://github.com/divan/txqr) — the classic animated-QR reference implementation.

## License

MIT — see [LICENSE](LICENSE).
