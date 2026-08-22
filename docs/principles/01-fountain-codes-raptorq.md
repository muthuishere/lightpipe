# Fountain codes: the receiver only has to say *how many*, never *which*

Every reliable protocol you have ever used works the same way: the sender numbers
the packets, the receiver notices gaps, and the receiver asks for the missing
numbers back. TCP does it. ARQ does it. Animated-QR transfer tools do it by
looping the animation until you have seen every frame.

That design has a hard requirement hidden inside it — a **return path**. The
receiver must be able to say "give me 7, 12 and 19 again". Our channel is a screen
pointed at a camera. There is no return path, and building one costs a second
device orientation, a second modem, or a microphone (see
[ADR-0005](../adr/0005-no-backchannel-human-integer.md)).

Fountain codes delete the requirement instead of paying for it.

## The idea

A fountain encoder takes K source symbols and emits an **endless** stream of
distinct coded symbols. Each one is some combination of the sources. Collect any
K + ε of them — *any* K + ε, in any order, with duplicates and gaps — and you can
reconstruct the original. It is called a fountain because you hold a cup under it
and it does not matter which drops you catch.

```
   source: [ s0 s1 s2 s3 ]           K = 4

   stream: c0 c1 c2 c3 c4 c5 c6 c7 c8 c9 ...   (endless, all distinct)
             \        \     \        \
   caught:    c0       c3    c5       c8       ->  4 caught, decode succeeds
```

The receiver's entire state is a count. "I have 4, I need 4, I am done." It never
learns, and never needs to learn, that c1, c2, c4, c6, c7 and c9 went past.

This is the keystone of the whole project. Because the missing-block set never has
to travel backwards, the back-channel collapses from "a list of block indices" to
"one small integer", and one small integer is something a human can read off a
screen and type. Everything else in the design — no pairing, no radio, one-way
optics — hangs off that.

## Why RaptorQ and not something we could write ourselves

The obvious build-it-yourself option is plain LT codes: pick a degree from a
soliton distribution, XOR that many random source symbols, send the seed. It is
about 200 lines. [ADR-0004](../adr/0004-fountain-codes.md) rejected it anyway,
because LT's reception overhead is roughly 5–10% — you need 1.05–1.10 × K symbols,
and the tail is long.

RaptorQ (RFC 6330) adds a precoding stage and inactivation decoding, and drops the
overhead to near zero. It is also a correctness minefield: GF(256) arithmetic,
precoding matrices, systematic indices. This is precisely why the language choice
went the way it did — Rust has a tested `raptorq` crate, and
[ADR-0007](../adr/0007-rust-core-wasm-browser-only.md) says outright that Zig was
rejected *only* because we would have had to write RaptorQ ourselves.

## The measured result: overhead is one packet, not a percentage

ADR-0004 quotes "~0.2% overhead". Spike S3 swept 3 chunk sizes × 3 frame
capacities × 8 drop rates (0–70%), 50 trials each — 3,600 decodes, all successful
([`s3-overhead.csv`](../../artifacts/s3-overhead.csv)). The result is more
interesting than the claim:

- Sweep mean overhead **0.011%**; worst single cell **0.222%**.
- **3,589 of 3,600 trials decoded at exactly K packets** (99.69%).
- The worst single trial anywhere in the sweep needed **K + 1**.

So the honest statement is not "RaptorQ costs 0.2%". It is: **absolute overhead
never exceeded one packet**, at any chunk size, any capacity, any drop rate. The
RFC 6330 figure is a *tail bound*, and the tail turns out to be one packet wide.

That reframing matters because a constant shrinks as K grows. At K = 268 (a 1 MB
chunk on the potato layer) one packet is 0.37% worst case and 0.00% observed. The
bigger the transfer, the more nearly free the coding is.

Frame cost under loss tracks 1/(1−p) almost exactly — the loss dominates and the
coding is invisible next to it. A 1 MB chunk at 3,927 B/frame is 268 frames clean
and 883 frames at 70% loss (17.9 s vs 58.9 s at 15 FPS).

## The endless stream is actually finite, and we checked

`next_packet()` is documented as endless, but RaptorQ's encoding symbol ID is a
24-bit field (RFC 6330 §3.2), so one source block can emit at most
**2²⁴ = 16,777,216** distinct packets. At 15 FPS that is **12.9 days** of
continuous sending. S3 verified this rather than assuming it: one test decodes from
packets drawn at ESI ≈ 2²⁴, another decodes from a subset drawn entirely *after*
10 × K packets, having seen no source symbol at all.
`crates/core/src/fountain.rs` wraps back to 0 at the ceiling rather than panicking,
so a sender that literally never stops keeps sending something decodable.

## What it costs on the receiver

**~1.1 µs/KB** with loss (1.11 ms for a whole 1 MB chunk), and **~0.1 µs/KB** at
0% loss, where every source symbol arrives and RaptorQ skips the solver entirely.
That is roughly four orders of magnitude cheaper than the optical layer. The
fountain will never be the bottleneck.

## Rejected

- **Plain LT codes** — ~200 lines, easy to own, 5–10% overhead. Revisit only if we
  leave Rust.
- **ARQ / selective repeat** — needs the back-channel we deleted, and camera
  latency of 100–250 ms would collapse throughput to single digits.

Next: [CRC32 and erasure semantics](04-crc32-and-erasure-semantics.md) — how a
frame becomes a clean erasure instead of a corrupt packet.
