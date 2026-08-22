# ADR-0004: Fountain codes across frames, CRC-drop within frames

Status: Accepted · 2026-08-22

## Context
The channel is one-way and lossy. Frames tear (screen refresh and camera shutter are
unsynchronised), get blurred, glared on, or dropped entirely. Retransmission needs a
back-channel we have decided not to have (ADR-0005).

## Decision
Two layers:
1. **Within a frame** — CRC32 over header+payload. A frame that fails is *dropped*,
   never partially trusted. It becomes an erasure.
2. **Across frames** — RaptorQ (RFC 6330, `raptorq` crate). The sender emits an
   endless stream of distinct coded blocks; the receiver reconstructs after any
   N+ε of them, in any order.

## Consequences
- **The sender never needs to know which blocks were lost.** This is the property
  that lets the back-channel collapse to a single integer (ADR-0005). It is the
  keystone decision of the whole protocol.
- Reception overhead ~0.2% versus ~5–10% for plain LT codes.
- Frames arriving out of order is normal, not an error path.
- False-accept rate of the CRC must be ~0 or corruption reaches the fountain
  decoder as truth. Verified in spike S2.

## Alternatives rejected
- **Plain LT codes** — ~200 lines and easy to own, but ~5–10% overhead and the
  `raptorq` crate already exists and is tested. Revisit only if we leave Rust.
- **ARQ / selective repeat** — needs a back-channel; RTT (camera latency 100–250 ms)
  would collapse throughput to single digits.
