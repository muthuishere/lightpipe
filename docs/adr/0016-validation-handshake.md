# ADR-0016: A validation handshake before the blind transfer

Status: Accepted · 2026-08-22
Refines ADR-0005 (does not overturn it).

## Context
ADR-0005 made the transfer one-way with no back-channel: the sender loops the
fountain stream forever and a human reads "need N more" off the receiver. In
practice that produces a bad and confusing experience, observed live:

- A ~100-byte note was broadcast **2,405 times over 40 seconds** because the sender
  has no way to know the receiver decoded it on frame 3.
- The person watching the **sender** screen sees no status at all — and cannot, because
  all real state (lock, quality, progress, completion) exists only on the receiver.
  The send view showed "measuring…" indefinitely, which reads as broken.

The user's instinct: "a small connection first to validate, instead of blindly
blasting." That is correct, and it is a gap ADR-0005 never considered.

## The distinction ADR-0005 missed
ADR-0005 rejected a back-channel **for steady-state transfer** — per-packet ACK over a
100–250 ms camera round-trip would collapse throughput. That reasoning stands.

It did not consider a **one-time handshake**. A brief bidirectional phase before any
data frame is sent is a different thing entirely: it costs one round-trip total, not
one per packet, so it does not touch throughput.

## Decision
Two phases.

**1. Validate (brief, bidirectional — when both devices have a camera):**
   - Receiver renders a small fixed pattern: "I see a code, alignment X%, quality Q,
     ready." The sender reads it with its own camera.
   - Sender shows **LOCKED ON — receiver ready (quality Q)** and does not send a data
     frame until it does. If it never locks, it says so ("point the cameras at each
     other") instead of blasting into the void.

**2. Transfer (one-way, unchanged — ADR-0005 in full):**
   - Fountain broadcast, no per-packet ACK, receiver counts "need N more".
   - **Completion signal:** at the end the receiver flashes **DONE — you can stop**,
     which the sender reads and halts on. This is what stops a tiny note looping 2,405
     times. It is one more optical read, not a back-channel during transfer.

**Single-camera / screen-capture fallback (ADR-0011, ADR the screen source):**
   - No handshake possible. Keep blind broadcast, but:
     - the **receiver** is the single source of truth for all status;
     - the **sender** view must say plainly "watch the receiving device — this side
       cannot see progress," never a fake "measuring…";
     - the sender still loops forever, and that is stated, not implied.

## Consequences
- The dominant confusion — a blind sender with no feedback — is removed whenever two
  cameras exist, which is the common phone-to-laptop case.
- Tiny payloads complete in seconds instead of looping indefinitely.
- ADR-0005's throughput argument is untouched: the handshake is O(1) round-trips, the
  transfer stays one-way.
- **New requirement on the core:** a small, robust handshake codec (a few bytes each
  way) distinct from the data frame format — it must decode when the data profile does
  not, so it uses the most-reliable geometry (big cells, black/white). This is the same
  kind of thing as the L0 rung.
- The sender now needs a camera in the two-phase mode. It always had a screen; most
  laptops and phones have both, so the symmetric-peer model (ADR-0005) already assumed
  it.

## Open / follow-up
- The **manifest is still out-of-band** (ADR-0013's open gap). The handshake is the
  natural place to also confirm the receiver has the manifest before the transfer
  starts — fold that in when the manifest preamble is designed.
- First implementation may do the validation UX and the completion-stop signal
  app-side against a simple pattern, before the core grows a formal handshake codec.
