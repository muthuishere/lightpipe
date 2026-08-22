# Spike ladder

Rules (ADR-0010): every spike proves exactly one unknown, has automated tests,
is runnable by any human via `task spike:N`, and emits a visual artifact in
`artifacts/`. Nothing before S6 touches hardware. React is last.

Status: `PENDING` → `IN_PROGRESS` → `DONE` (with the measured number recorded).

---

## S0 — palette + cell round-trip · STATUS: DONE
**Measured (2026-08-22):** SER = 0.0 for P2/P4/P8 × cells {6,8,10,14,20} on the ideal
channel. P8 @ 8px = 11,781 B/frame; P4 @ 8px = 7,854 B/frame.
**Unknown:** does bytes → symbols → pixels → symbols → bytes survive a *perfect* channel?
**Acceptance:** random-byte property test, 1000 iterations, zero bit errors, both P4 and P8.
**Artifact:** `artifacts/s0-frame.png` — a frame you can look at.
**ADRs:** 0002, 0003

## S1 — degraded channel sweep · STATUS: DONE
**Superseded twice — read the third table, not the first.**

**Measured 2026-08-22, regenerated after S2 added the 2-row header band.**
Clean-decode (SER=0) frontier per simulated camera, **no perspective warp**:

| camera | best clean layer | B/frame |
|---|---|---|
| good (phone) | P8 @ 6px | 20,868 |
| webcam | P8 @ 8px | 11,602 |
| potato | P8 @ 14px | 3,645 |

**These are upper bounds and were never achievable.** S4 re-measured with realistic
hand-held geometry and the frontier dropped 26–70%; see the S4 entry and
`artifacts/s4-frontier.csv` for the numbers that matter. Use this table only to reason
about the *optical* limit in isolation from framing.

**Correction history:**
- The original S1 run reported potato best = P2 @ 8px, 3,927 B. S2's 2-row header
  band shifted the payload origin, re-phasing the cell grid against the sensor
  resample grid, and that rung lost SER 0 → 1.6e-4. The 3,927 → 3,867 B delta is
  exactly the header band (238 cols × 2 rows × 1 bit / 8 ≈ 60 B), so the stale figure
  is provably pre-header.
- Every 14px and 20px rung stayed at exactly SER 0 through that change.

**Surprises (both still stand):**
- **SER is non-monotonic in cell size.** Cell pitch aliases against the sensor
  resample grid, so ladder rungs must be read from the CSV, never interpolated.
  This is not a curiosity: it is why a two-row layout change silently cost a rung.
- 6px collapses on anything below "good".
- **P8 (3 bits, full colour) wins at every rung, including the potato's.** The drafted
  assumption in ADR-0011 that a bad camera needs a 1-bit black-and-white layer is not
  supported by any measurement. Colour survives; resolution does not.

## S2 — frame integrity · STATUS: DONE
**Measured (2026-08-22):** **false-accept rate = 0 / 101,000 corrupted frames**
(100,000 symbol-level + 1,000 pixel-level). Corruption swept from 1 symbol to 30% of
all cells. 99,691 frames were dropped; 309 were accepted and every one returned
byte-identical data (the corruption had landed entirely in the padding tail, outside
the CRC-covered bytes). Not one corrupt payload was ever presented as truth.

Header record: **25 B** — `magic u16 · version u8 · seq u32 · payload_len u16 ·
oti[12] · crc32 u32`. CRC32 covers bytes 0..21 **and** `payload[..payload_len]`.
Band = `FrameSpec::HEADER_ROWS = 2` grid rows between the calibration strip and the
payload; the record is repeated across the whole band and the decoder accepts the
**first copy whose CRC validates**. No voting — the CRC is the arbiter, so one
surviving copy is enough. A frame where none validates is dropped whole (ADR-0004).

Per-frame capacity and header overhead at 1920x1080:

| pal | cell | payload B/frame | band B | copies | overhead |
|---|---|---|---|---|---|
| P4 |  8 |  7,735 | 119 | 4 | 1.52% |
| P4 | 10 |  4,892 |  95 | 3 | 1.90% |
| P4 | 14 |  2,430 |  67 | 2 | 2.68% |
| P8 |  8 | 11,602 | 178 | 7 | 1.51% |
| P8 | 10 |  7,338 | 142 | 5 | 1.90% |
| P8 | 14 |  3,645 | 101 | 4 | 2.70% |

Clean round-trip is exact for P4/P8 × cell {8,10,14}. The header decodes under
`Channel::webcam()` at P4/P8 × {8,10,14} and under `Channel::potato()` at P4/P8 ×
{14,20} — every layer the S1 sweep reports clean for that camera. **ADR-0011 holds:
the potato still has clean layers, best = P8 @ 14px = 3,645 B/frame.**

**Surprise:** moving the payload origin down 2 rows re-phased the cell grid against
the sensor resample grid, and `artifacts/s1-sweep.csv` shifted with it — potato
**P2 @ 8px lost SER 0** (now 1.6e-4) while every 14px and 20px rung stayed clean. This
is the S1 aliasing warning biting for real: **any change to frame layout invalidates
the ladder and the sweep must be re-run**, never interpolated.

**Unknown:** can we detect a corrupt frame without ever silently accepting one?
**Acceptance:** header + CRC32; false-accept rate measured over 100k corrupted frames
must be 0. Bad frames become erasures, never truth.
**Artifact:** `artifacts/s2-integrity.txt`
**ADRs:** 0004, 0011

## S3 — fountain across frames · STATUS: DONE
**Measured (2026-08-22)** — 72 cells (3 chunk sizes × 3 S1 frame capacities × 8 drop
rates), 50 trials each, 3,600 decodes, all successful. Erasure channel is a simulated
packet drop, not a frame decode: this spike owns the byte/packet layer only.

**Reception overhead** (packets needed ÷ K, minus 1):

| drop rate | 0% | 10% | 20% | 30% | 40% | 50% | 60% | 70% |
|---|---|---|---|---|---|---|---|---|
| worst cell at that rate | 0.00% | 0.17% | 0.06% | 0.22% | 0.01% | 0.12% | 0.12% | 0.03% |

- Sweep mean **0.011%**; worst single cell **0.222%** (64 KB @ 7,854 B, 30% loss, K=9).
- **3,589 of 3,600 trials decoded at exactly K packets** (99.69%). The worst single
  trial anywhere in the sweep needed **K + 1**. Absolute overhead never exceeded one
  packet, at any chunk size, any capacity, any drop rate.
- **ADR-0004's ~0.2% claim HOLDS** — and is conservative. 0.2% is roughly the *worst*
  cell; the typical cost is zero extra packets. Overhead is an absolute constant
  (≤1 packet), not a percentage, so it *shrinks* as K grows: at K=268 it is ≤0.37%
  worst case and 0.00% observed.

**What a 1 MB chunk costs** (mean frames the sender must emit, 15 FPS):

| layer | K | 0% | 30% | 50% | 70% loss |
|---|---|---|---|---|---|
| potato P2@8px (3,927 B) | 268 | 268f / 17.9s | 383f / 25.5s | 532f / 35.5s | 883f / 58.9s |
| webcam P4@8px (7,854 B) | 134 | 134f / 8.9s | 189f / 12.6s | 263f / 17.5s | 441f / 29.4s |
| webcam P8@8px (11,781 B) | 90 | 90f / 6.0s | 128f / 8.6s | 180f / 12.0s | 302f / 20.1s |

Frame cost tracks 1/(1−p) almost exactly — the coding cost is invisible next to the loss.
**ADR-0011 satisfied:** the potato layer completes at every drop rate up to 70%; it is
slower (3.0× the P8 layer at 0% loss), never a failure.

**Decode CPU** (receiver side, push + solve, release build, M-series):
**~1.1 µs/KB** with loss (1.11 ms for a whole 1 MB chunk), and **~0.1 µs/KB** at 0% loss
where all source symbols arrive and RaptorQ skips the solver entirely. Decoding is ~4
orders of magnitude cheaper than the optical layer — it will never be the bottleneck.

**Endless-stream ceiling: 2^24 = 16,777,216 packets per source block.** The RaptorQ
encoding symbol ID is a 24-bit field (RFC 6330 §3.2) and the crate asserts it. At 15 FPS
that is **12.9 days** of continuous sending before the stream must wrap — effectively
endless for ADR-0005's "sender loops forever". Verified, not assumed: a test decodes
from packets drawn at ESI ≈ 2^24, and another decodes from a subset drawn entirely
*after* 10× K packets, having seen no source symbol at all.

**Surprises:**
- Overhead is **0 packets, not 0.2%**, in 99.7% of trials. The RFC 6330 figure is a
  tail bound, and the tail is one packet wide.
- The 4-byte FEC Payload ID must come out of the frame payload, so the usable symbol is
  `capacity − 4` (3,923 / 7,850 / 11,777 B). Cheap, and it keeps packets self-describing
  so the frame header needs no sequence number — only the 12-byte OTI.

**Caveat:** capacities are the S1 frame payloads. S2 has since added a 25-byte header
plus a fiducial band (P8@8px → 11,602 B), so the real per-frame capacity is a little
smaller. That shifts K by a few percent and nothing else — overhead here is measured
per packet and is capacity-independent.

**Unknown:** how many frames does a file actually cost under loss?
**Acceptance:** RaptorQ round-trip with random frame drops swept 0–70%; reconstruction
succeeds at every rate; overhead measured. **Must complete under the potato profile.**
**Artifact:** `artifacts/s3-overhead.csv` + printed table (`task spike:3`)
**API:** `fountain::Transmitter` (endless `next_packet()`, `oti() -> [u8;12]`) /
`fountain::Receiver` (`push()` any order, `needed_more()`, `finish()`).
**ADRs:** 0004, 0011

## S4 — geometry · STATUS: DONE
**Measured (2026-08-22).** Pipeline is `render -> stamp_fiducials -> channel ->
rectify -> sample`; `modem::sample` is untouched, it just gets a rectified frame.

**Fiducial:** four corner bullseyes, 6 units square — black ring / white ring /
black centre dot, on a 1-unit white quiet zone. Pure black-and-white, because
ADR-0003 makes luma the full-resolution channel; the marker needs no chroma at
all. Side = `8 * cell` px clamped to [72, 96]; margin = `marker * 4/3`.

**Detection accuracy** (RMS distance from the true projected centre, P8 @ 10px):

| camera | rms px | worst px |
|---|---|---|
| good + warp   | 0.88 | 1.41 |
| webcam + warp | 1.05 | 1.82 |
| potato + warp | 1.43 | 1.96 |

Sub-pixel on every camera, and the ideal channel recovers the centres exactly
(rms 0.000) — the ring centroid is affine-covariant, so rotation, scale and
translation cost nothing and only perspective biases it.

**Acceptance — all PASS** (`Channel::webcam()`, screen at 52% of the sensor
frame; "clean" = SER 0 at the best layer, per ADR-0011's layered reading):

| case | best clean layer | B/frame |
|---|---|---|
| ±15° roll | P8 @ 14px | 2,433 |
| ±20% scale | P8 @ 14px / P8 @ 20px | 2,433 / 1,182 |
| off-centre +8%/−6% | P8 @ 14px | 2,433 |
| barrel k = −0.10 | P8 @ 14px | 2,433 |
| +15° roll + 20% scale + off-centre + barrel | P2 @ 8px | 2,916 |
| −15° roll − 20% scale + 15°/8° off-axis + off-centre + barrel | P8 @ 20px | 1,182 |

**Warp frontier** (P8 @ 20px, framed as large as each pose allows):
in-plane rotation is clean over the **whole ±40° swept range**; off-axis viewing
is clean to **35° yaw / 17° pitch** and the fiducials are lost past 40°; barrel
is clean to **k = −0.20** and breaks at −0.25 (the radial model stops being
monotone inside the image near k = −1/3). At P8 @ 10px the same limits are
±15° roll, 20° yaw, k = −0.20.

**Revised clean-decode frontier, warp enabled** — the S1 numbers were flagged as
upper bounds, and they were:

| camera | S1 (published, no warp) | S1 today (post-S2) | S4 with warp | vs S1 |
|---|---|---|---|---|
| good + warp   | P8 @ 6px = 21,405 | P8 @ 6px = 20,868  | P8 @ 8px = 8,748  | **−59.1%** |
| webcam + warp | P8 @ 8px = 11,781 | P8 @ 8px = 11,602  | P8 @ 8px = 8,748  | **−25.7%** |
| potato + warp | P2 @ 8px = 3,927  | P8 @ 14px = 3,645  | P8 @ 20px = 1,182 | **−69.9%** |

**ADR-0011 still holds with warp:** the hand-held potato decodes P8 @ 20px
cleanly, 1,182 B/frame = 17.7 KB/s at 15 FPS. It completes; it is just slow.
The L0 rung must move to **20px**, not the 8–14px S1 suggested.

**Surprises:**
- **Framing, not the decoder, is the binding constraint on rotation.** A 16:9
  screen rotated 15° needs `1920 sin15 + 1080 cos15` = 1540 px of sensor height,
  so it can only fill 68% of the frame. Rotation itself is free — the decoder is
  clean to ±40° — but every degree of roll costs screen area, and screen area is
  resolution. That is where the throughput went, not into the homography.
- **Most of the loss is scale, not warp.** The rectifier is essentially exact
  (fiducials to ~1 px, barrel `k` recovered to ±0.003); what kills density is
  that a hand-held camera frames the screen at 80% and off-axis, so a 6 px cell
  arrives as 3 sensor pixels.
- **A rolling-shutter tear never costs the geometry.** The fiducials are
  identical in every frame, so a seam at any height still yields four markers and
  a valid homography — it only corrupts payload (SER 2.1e-2 / 3.8e-1 / 7.5e-1 at
  25 / 50 / 75% seam height), which is exactly the erasure S2 and S3 already
  handle.
- **Four points cannot give you the lens.** They pin the homography exactly, so
  barrel `k` is unobservable from the fiducials. It is recovered instead by
  maximising a Fisher ratio (between-cell / within-cell luma variance) over the
  frame's own grid. Scoring on raw contrast instead does **not** work: it has a
  degenerate maximum at |k| near 1/3 where the radial model folds the image.
- **Fiducials cost 15–25% of the frame before any warp.** The margin has to grow
  from 1 cell to `marker * 4/3` to hold them, and per S2's warning that re-phases
  the grid, so the ladder must be read from `artifacts/s4-frontier.csv`.
- Failure is loud: no fiducials means `rectify` returns `None`, never a decode.

**Unknown:** can we recover the grid from a hand-held, off-axis camera?
**Acceptance:** fiducial detection + homography; decode survives ±15° rotation,
±20% scale, off-centre translation, and barrel distortion in the simulator.
**Artifact:** `artifacts/s4-warped.png`, `artifacts/s4-rectified.png`,
`artifacts/s4-frontier.csv`
**ADRs:** 0002, 0009, 0011

## S5 — chunked gzip pipeline · STATUS: DONE
**Measured (2026-08-22)** — 256 KB chunks, one RFC 1952 gzip member per chunk,
deflate level 6, BLAKE3 per chunk (plaintext) + whole file.

**Peak RSS on a 1 GB synthetic file: 4.6 MB** (1.7 MB baseline → 3.5 MB after the
manifest pass → 4.6 MB after transferring all 4,096 chunks out of order → 4.6 MB
after streaming the whole-file BLAKE3 back off disk). That is **0.0045×** the file
size, and it is a *measurement* (`getrusage(RUSAGE_SELF).ru_maxrss`, in a re-exec'd
child so no earlier section pollutes the high-water mark), not an assertion. Memory
tracks chunk size, never file size. Manifest cost is 44 B/chunk = 180 KB for 1 GB
(0.017%). Wire size 289.4 MB (28.3%). 1 GB end to end in ~80 s single-threaded.

**Compression cost of chunking vs whole-file gzip:**

| corpus | whole-file ratio | 64 KB | **256 KB** | 1 MB |
|---|---|---|---|---|
| prose | 0.354 | 11.02% | **2.93%** | 0.66% |
| source-like | 0.272 | 10.25% | **2.62%** | 0.59% |
| this repo (real .rs/.md, 0.2 MB) | 0.301 | 3.59% | — (one chunk) | — |
| already-compressed blob | 1.000 | −0.02% (raw) | −0.02% (raw) | −0.02% (raw) |

**ADR-0006's 1–3% estimate is CONFIRMED at the 256 KB default** (worst 2.93%) — but
only there. See the surprise below.

**Compressibility probe:** threshold 0.95 (compressed/plain of the **first chunk
only**). Text 0.359 → gzip, source 0.281 → gzip, incompressible blob 1.000 → raw.
On 64 MB of incompressible data, gzip-everything costs 0.80 s (79.7 MB/s) versus
3.1 ms to probe one chunk — **258× less CPU, ~12.8 s saved per GB** — and gzipping
it would have made the payload 0.02% *bigger*.

**Resume code (ADR-0005):** `<chunk>-<need><check>`, Crockford base32 uppercase, one
trailing 5-bit BLAKE3 check character. **4–9 characters total; ≤8 for any 1 GB
transfer (4,096 chunks), typically 5–7** — the measured run printed `P-AM2`, 5 chars.
Case-insensitive, O/I/L alias to 0/1/1, whitespace ignored; the check char rejects
>90% of single-character typos (measured over 4,224 mutations). Display code is 6
Crockford chars = 30 bits of the whole-file BLAKE3.

**Partial progress is real, and proven:** killed at 22/32 chunks (68.8% = 5.50 MB of
8.00 MB) on a real seekable file; a fresh receiver given nothing but the manifest,
the file, and the typed code re-read all 22 retained chunks off disk and re-verified
each against its manifest BLAKE3 — **22/22 passed, only the remaining 10 were
re-sent**, and the finished file was byte-identical. A tampered partial chunk is
detected and re-fetched (test `resume_rejects_a_tampered_partial_file`).

**Gzip framing is browser-interoperable** (ADR-0007): a `flate2` member decodes under
Node v24.18's `DecompressionStream('gzip')` byte-identically, and a
`CompressionStream('gzip')` member decodes under `flate2` byte-identically (300,000 B
both ways). Nothing custom, no raw deflate.

**Surprises:**
- **The 1–3% figure is a property of 256 KB, not of chunking.** At 64 KB the penalty
  is **10–11%** — 3–4× the ADR's number. Cause: deflate's window is only 32 KB, so a
  64 KB chunk spends half its length warming up a dictionary it then throws away. At
  1 MB the penalty is 0.6%. 256 KB is close to the knee; anything smaller is
  expensive. **The rate ladder must never shrink the chunk below 256 KB to chase
  latency** without re-running this measurement.
- **Chunking is free on the inputs people actually send.** Photos, video and archives
  probe as incompressible and go raw, where chunk size costs exactly nothing. The
  1–3% is paid only on text and source, which are small to begin with.
- Peak RSS *fell* relative to expectation: gzip working set (~300 KB) plus one chunk
  buffer dominates, so a 4 GB file would look the same. The bounded-memory claim of
  ADR-0006 was the one most likely to be hand-waved; it is the one that held best.

**Unknown:** does per-chunk fountain + per-chunk gzip give real partial progress?
**Acceptance:** out-of-order chunk arrival; kill mid-transfer, resume from the typed
code, verify BLAKE3 matches. Memory stays bounded on a 1 GB synthetic file.
**Artifact:** `artifacts/s5-pipeline.txt`
**Caveat / not yet integrated:** the fountain layer is consumed through a local seam
(`PacketEmitter` / `PacketCollector` / `ChunkFountain` in `pipeline.rs`) driven by an
in-file `StubFountain` — a plain round-robin block repeater with no coding gain. S3's
real RaptorQ encoder implements the same shape; wiring the two together is a separate
integration step, and the 1 GB timings above exclude fountain cost.
**ADRs:** 0005, 0006, 0008

## S6 — real capture fixtures · STATUS: PENDING
**Unknown:** how wrong is the simulator?
**Acceptance:** a real webcam PNG sequence in `fixtures/` decodes through the *same*
decoder. Divergence between simulated and real SER is recorded and treated as a
simulator bug.
**Human required:** yes — first spike that needs a camera.
**Procedure:** [`S6-CAPTURE-GUIDE.md`](S6-CAPTURE-GUIDE.md) — no code needed, ~10 minutes.
**ADRs:** 0009

## S7 — wasm + Node harness · STATUS: PENDING
**Unknown:** does the wasm boundary cost or break anything?
**Acceptance:** the S0–S5 test suite runs through the compiled wasm in Node.
Still no browser. Zero-copy frame handoff verified.
**ADRs:** 0007

## S8 — React app · STATUS: PENDING
**Unknown:** can the browser hit the frame rate?
**Acceptance:** getUserMedia → decode → OPFS write at target FPS; sender loop at
target FPS; measured end-to-end KB/s on real hardware.
**ADRs:** 0007, 0008
