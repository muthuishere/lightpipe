# ADR-0017: Receiver starts first, and a preflight "doctor" runs before any transfer

Status: Accepted · 2026-08-22
Implements the validate phase of [ADR-0016](0016-validation-handshake.md), one-sided.

## Context
Two questions had no answer anywhere in the project, and both cost a real user a real
session:

1. **Who starts first?** Undefined. The docs describe both sides but never the order.
2. **How do you know the setup will work before committing to a transfer?** You did
   not. The first real-camera test produced **385 frames seen, 385 unreadable,
   nothing decoded** — with correctly framed fiducials. The only feedback was
   "Nothing is decoding" plus a paragraph of guesses. The actual causes (focus pinned
   to manual, so the image was smeared; and a mostly-black sparse frame) were
   invisible to the user and took a photograph to diagnose.

A transfer that fails silently for six minutes is worse than one that refuses to start.

## Decision

### 1. Receiver starts first
Order is **receiver → aim → sender**.

Fountain coding means a receiver can join mid-stream at no cost (ADR-0004), so this is
a UX rule, not a protocol constraint. It exists because the receiver is the side that
needs positioning, focus and framing settled *before* anything depends on it, and
because the sender broadcasts blind (ADR-0005) and cannot tell whether anyone is ready.

Both UIs state the order explicitly. The sender says "start the receiver first".

### 2. A preflight doctor, runnable without a transfer
A dedicated mode on both sides:

- **Sender → "Test pattern".** Renders a *static* known frame — full palette, all four
  fiducials, a known payload. Static matters: the user can hold the phone still and
  nothing changes underneath them.
- **Receiver → "Check my setup".** Watches that pattern and reports, per named check,
  pass/fail with a *specific* remedy:

| check | what it measures | failure tells the user |
|---|---|---|
| fiducials | all four found | "aim — the code isn't fully in view" |
| **sharpness** | edge contrast / focus estimate | **"out of focus — turn off pinned focus"** |
| fill | code area ÷ view area | "move closer — it fills only 30%" |
| exposure | clipping, mean luma | "too bright / too dark — kill glare" |
| colour separation | distance between decoded palette clusters | "colours washed out — try Most reliable" |
| **symbol error rate** | measured against the known payload | the single honest number |

It ends with a verdict and a **recommended quality setting** derived from the measured
SER, not guessed.

### 3. The doctor is the diagnostic surface
When a real transfer fails, the UI points at the doctor rather than printing advice.
"Nothing is decoding" becomes "run Check my setup to find out why."

## Consequences
- The blind-sender problem (ADR-0016) is materially reduced without any back-channel:
  the user validates the link *before* committing, on a static pattern, at leisure.
- Measured SER on a known payload also gives us **real S6 data** as a side effect —
  every user who runs the doctor produces a real-camera measurement, which is exactly
  what `docs/spikes/S6-CAPTURE-GUIDE.md` has been waiting on a human to collect.
- The sender needs a static-test-pattern mode; the receiver needs analysis it does not
  have today (sharpness, fill, exposure, colour separation are all new).
- Cost: real work, and a second UI surface on each side. Justified — the alternative is
  what happened on the first real test.

## What this does not do
It is not the bidirectional handshake of ADR-0016. There is still no back-channel: the
sender does not learn the result. A human reads the doctor's verdict and acts.
