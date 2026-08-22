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
**Measured (2026-08-22)** — clean-decode (SER=0) frontier per simulated camera:

| camera | best clean layer | B/frame | @15 FPS |
|---|---|---|---|
| good (phone)  | P8 @ 6px  | 21,405 | 321 KB/s |
| webcam        | P8 @ 8px  | 11,781 | 177 KB/s |
| **potato**    | P2 @ 8px  |  3,927 |  59 KB/s |
| potato (alt)  | P8 @ 14px |  3,746 |  56 KB/s |

**Surprises:**
- The potato is far more capable than assumed — it reads **P8 @ 14px cleanly**, so
  full 3-bit colour survives heavy blur + 0.42 resample + 4:2:0 + hard MJPEG. The
  ADR-0011 L0 floor can be much higher than the drafted ~20px/1-bit.
- **SER is non-monotonic in cell size.** Potato P2 is clean at 8px but 1.2e-3 at 10px.
  Cell size aliases against the sensor resample grid, so ladder rungs must be chosen
  from this CSV, never by interpolation.
- 6px collapses on anything below "good" (potato P8 @ 6px = 5.6e-1).

**Caveat:** the simulator has no perspective warp (S4) and no frame tearing yet.
These numbers are an upper bound and will come down.
**Unknown:** what cell size and palette actually survive a real camera?
**Acceptance:** symbol-error-rate surface over cell size × palette × blur σ × noise ×
4:2:0 on/off × gain drift. Must include the **potato-camera profile** (ADR-0011) and
show at least one layer decoding cleanly under it.
**Artifact:** `artifacts/s1-sweep.csv` + printed table. **This CSV becomes the rate ladder.**
**ADRs:** 0003, 0009, 0011

## S2 — frame integrity · STATUS: PENDING
**Unknown:** can we detect a corrupt frame without ever silently accepting one?
**Acceptance:** header + CRC32; false-accept rate measured over 100k corrupted frames
must be 0. Bad frames become erasures, never truth.
**ADRs:** 0004

## S3 — fountain across frames · STATUS: PENDING
**Unknown:** how many frames does a file actually cost under loss?
**Acceptance:** RaptorQ round-trip with random frame drops swept 0–70%; reconstruction
succeeds at every rate; overhead measured. **Must complete under the potato profile.**
**Artifact:** `artifacts/s3-overhead.csv`
**ADRs:** 0004, 0011

## S4 — geometry · STATUS: PENDING
**Unknown:** can we recover the grid from a hand-held, off-axis camera?
**Acceptance:** fiducial detection + homography; decode survives ±15° rotation,
±20% scale, off-centre translation, and barrel distortion in the simulator.
**Artifact:** `artifacts/s4-warped.png` + recovered overlay
**ADRs:** 0002, 0009

## S5 — chunked gzip pipeline · STATUS: PENDING
**Unknown:** does per-chunk fountain + per-chunk gzip give real partial progress?
**Acceptance:** out-of-order chunk arrival; kill mid-transfer, resume from the typed
code, verify BLAKE3 matches. Memory stays bounded on a 1 GB synthetic file.
**ADRs:** 0005, 0006

## S6 — real capture fixtures · STATUS: PENDING
**Unknown:** how wrong is the simulator?
**Acceptance:** a real webcam PNG sequence in `fixtures/` decodes through the *same*
decoder. Divergence between simulated and real SER is recorded and treated as a
simulator bug.
**Human required:** yes — first spike that needs a camera.
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
