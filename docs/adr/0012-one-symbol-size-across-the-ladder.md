# ADR-0012: One fountain symbol size across the whole rate ladder

Status: Accepted · 2026-08-22 · Amends [ADR-0011](0011-layered-rate-ladder-bad-cameras.md)

## Context

ADR-0011 chose **layered broadcast**: the sender interleaves several profiles into
one continuous stream, and "the receiver harvests blocks from whichever layers it
can decode". It rejected a sender-side ladder sweep precisely because a sweep
"wastes the whole airtime of every profile the receiver cannot use".

Integrating the fountain layer (ADR-0004) with the frame layer for the first time
showed that, as specified, interleaving has exactly the same waste.

A RaptorQ source block is defined by its **Object Transmission Information**: a
transfer length and a **symbol size** (RFC 6330 §3.3). `fountain::Transmitter::new`
takes the symbol size straight from the frame payload capacity, so each rung of the
S4 ladder produces a *different* symbol size:

| rung | frame capacity | symbol size |
|---|---|---|
| L3 dense (P8 @ 8px) | 8,748 B | 8,744 B |
| L0 coarse (P8 @ 20px) | 1,182 B | 1,178 B |

Symbols of different sizes belong to different encodings. They cannot be pooled
into one decoder — `Receiver::push` rejects any packet whose length is not
`symbol_size + 4`, and it is right to. So a good camera that decodes both a dense
and a coarse frame ends up running **two independent fountains over the same
chunk** and can only finish on whichever one completes first. Every coarse frame it
decoded perfectly is still wasted airtime. That is the sweep, with finer
interleaving.

## Decision

**The whole ladder shares one symbol size: the coarse rung's.** A frame carries
`floor(capacity / packet_size)` whole packets, so a dense frame carries several
packets and a coarse frame carries one. Every packet in the broadcast belongs to
the same source block, whatever layer carried it.

## Consequences

- Harvesting across layers becomes real: a receiver pools every packet it can read,
  from any rung, into one decoder. This is the property ADR-0011 claimed and did not
  have.
- Cost is **granularity**, and it is small: at the measured rungs a dense frame
  carries 7 × 1,182 = 8,274 B of the 8,748 B it could hold — **5.4%**. In exchange
  the good camera recovers 100% of the airtime spent on coarse frames instead of 0%.
  Measured end to end in `artifacts/e2e-report.txt` ("LAYERED BROADCAST"): both
  `good_handheld` and `potato_handheld` complete the same chunk off one broadcast.
- The 4-byte FEC Payload ID is now paid per **packet**, not per frame: 0.34% at the
  shared symbol size versus 0.05% at the dense symbol size. Still noise next to the
  15–34% the fiducials cost (ADR-0002).
- The receiver must still run one rectify+decode per layer geometry per captured
  frame, as ADR-0011 said — roughly a doubling of receive-side CPU for a two-rung
  ladder. Under [ADR-0015](0015-cache-the-homography.md) that doubling is two cached
  warps plus two `decode_frame` calls (0.5 ms each), not two geometry fits, so the
  cost of a wider ladder is now bounded by the warp, not by the solver.
- `symbol_size` is now a property of the **transfer**, not of the frame layout. It
  belongs in the OTI, where it already is, and the layer a frame belongs to is
  discovered by trying each geometry and letting the CRC arbitrate.

## Alternatives rejected

- **Per-layer symbol size (ADR-0011 as written)** — the receiver cannot pool, so
  every layer it does not finish on is wasted. Retained only if a future ladder ever
  runs a single rung.
- **Nested/hierarchical modulation** (coarse bits recoverable from a dense frame's
  luma) — a genuinely better answer for the same problem, and ADR-0003's distinct
  luma levels make it plausible. It is a modem change, not a fountain change, and
  nothing has measured it. Revisit if the 5.4% granularity cost ever matters.
- **Pad every rung to a common frame capacity** — throws away 86% of the dense
  rung's frame instead of 5.4% of it.
