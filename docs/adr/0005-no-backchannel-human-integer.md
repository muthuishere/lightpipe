# ADR-0005: No automatic back-channel; the human types one integer

Status: Accepted · 2026-08-22

## Context
Reliability wants a return path. Three options were considered: mutual cameras
(both devices facing each other), an ultrasonic audio back-channel, and none.

Mutual cameras work geometrically — front cameras sit on the same face as the screen
on both laptops and phones — but: **neither screen is visible to a human**, so there
is no UI for progress or alignment; fixed-focus webcams are tuned for ~50–60 cm and
go soft at the ~25–30 cm needed to fill the frame; and each glossy panel reflects the
other's grid back as a ghost.

## Decision
No automatic back-channel. One camera, one direction. Because fountain codes are
rateless (ADR-0004), the receiver never needs to name *which* blocks it is missing —
only **how many more** it needs. That is one small integer a human can read and type.

Common case needs no typing at all:
- Sender loops the fountain stream forever.
- Receiver shows a live "need 340 more", then "COMPLETE ✓ a7f3c9".
- Human stops the sender.

The typed integer is used for exactly two optional things: **resume** (per chunk,
see ADR-0006) and an initial **rate-pick digit**.

Integrity is proven by rendering a BLAKE3 hash as a 6-character code on both screens
for the human to compare. Stronger than any ACK scheme, with zero protocol.

## Consequences
- The receiver's screen is free for a real UI: alignment guide, progress, error rate.
- We lose *live* adaptive rate control. ADR-0011 recovers it a different way.
- Works when microphones are banned, which some secure environments do.

## Alternatives rejected
- **Mutual cameras** — see above. Kept as a possible future mode behind the same
  control-channel interface.
- **Ultrasonic audio back-channel** — genuinely good (omnidirectional, no aiming,
  300–2000 bps is plenty for ACKs) and the interface is designed to accept it later.
  Rejected for v1 because it adds a second modem to build and debug, and because some
  air-gapped environments ban microphones as strictly as radios.
