# A frame is either true or gone: CRC32 and erasure semantics

There are two ways to handle a damaged packet. You can try to salvage what looks
intact — accept the bytes that "seem fine", flag the rest. Or you can throw the
whole thing away.

Salvaging is almost always wrong, and it is *catastrophically* wrong here.

## Why partial trust poisons a fountain

The layer above is a [fountain decoder](01-fountain-codes-raptorq.md). It solves a
linear system: every coded packet is an equation, and K independent equations give
you the file back. Feed it a packet with three flipped bits and you have not given
it a slightly-wrong equation. You have given it a *false* equation, and the solver
will happily satisfy it — producing an output that is confidently, silently,
entirely wrong.

There is no partial credit in a linear solve. A fountain decoder handles missing
equations beautifully (that is its whole job) and handles lying equations not at
all.

So [ADR-0004](../adr/0004-fountain-codes.md) splits the problem into two layers
with a hard boundary between them:

```
   within a frame:   CRC32.  Pass -> a packet.  Fail -> nothing at all.
   ----------------------------------------------------------------------
   across frames:    RaptorQ.  Sees only packets and gaps. Never sees damage.
```

The frame layer's contract is: **never hand the fountain a lie.** A frame that
fails becomes an *erasure* — the fountain's native, free, expected condition. It
already tolerates 70% erasure at a cost of 1/(1−p) frames and a mean overhead of
0.011%. Converting corruption into erasure is converting an unsolvable problem
into a solved one.

## The number that actually matters

Not "detection rate". Not "bit error rate". **False-accept rate** — the
probability that a corrupted frame passes its CRC and is presented to the fountain
as truth.

Everything else is a performance question. This one is a correctness question, and
it has to be zero, because a single false accept anywhere in a transfer produces a
file that is wrong and a hash that does not match, with no indication of which
frame did it.

Spike S2 measured it ([`s2-integrity.txt`](../../artifacts/s2-integrity.txt)):

> **false-accept rate = 0 / 101,000 corrupted frames**

100,000 symbol-level corruptions plus 1,000 pixel-level ones (cells repainted in
the rendered image), across four layout/palette combinations, with corruption
swept from a single symbol up to 30% of all cells. Of those, **99,691 were
dropped** and **309 were accepted** — and every one of the 309 returned
byte-identical data. Those were cases where the corruption landed entirely in the
padding tail, outside the `payload[..payload_len]` range the CRC covers. Not one
corrupt payload was ever presented as truth.

## The header record

25 bytes, laid out in `crates/core/src/header.rs`:

```
 offset size  field
   0     2    magic        u16 BE   ("TQ" = 0x5451)
   2     1    version      u8
   3     4    seq          u32 BE
   7     2    payload_len  u16 BE
   9    12    oti          opaque RaptorQ transmission info
  21     4    crc32        u32 BE
```

The CRC covers **bytes 0..21 and `payload[..payload_len]`** — the header fields
and the declared payload, together. One CRC, one verdict, no way to trust the
header while doubting the payload.

Magic and version are checked first as a cheap filter, before the CRC is computed
at all. That is not redundancy with the CRC; it is a way to reject obvious garbage
without hashing several kilobytes.

## Repetition without voting

The header band is `FrameSpec::HEADER_ROWS = 2` grid rows between the calibration
strip and the payload. The 25-byte record is repeated across the whole band as
many times as fits — 2 to 7 copies, depending on cell size and palette.

The decoder tries each copy in order and **accepts the first whose CRC
validates**. There is no majority voting.

That is the right call and worth understanding. Voting is what you do when you
have no way to tell which copy is correct — you count and hope. But the CRC *is*
that way. It is the arbiter. A copy that validates is right; a copy that does not
is wrong; the count of each is irrelevant. One surviving copy out of seven is
enough, and voting would only add a way to be outvoted by two correlated errors.

## What it costs

| palette | cell | payload B/frame | band B | copies | overhead |
|---|---|---|---|---|---|
| P4 | 8 | 7,735 | 119 | 4 | 1.52% |
| P4 | 10 | 4,892 | 95 | 3 | 1.90% |
| P4 | 14 | 2,430 | 67 | 2 | 2.68% |
| P8 | 8 | 11,602 | 178 | 7 | 1.51% |
| P8 | 10 | 7,338 | 142 | 5 | 1.90% |
| P8 | 14 | 3,645 | 101 | 4 | 2.70% |

1.5–2.7% of the frame, at 1920×1080. Cheap insurance against silent corruption.

The band decodes under `Channel::webcam()` at P4/P8 × {8,10,14} and under
`Channel::potato()` at P4/P8 × {14,20} — every layer the S1 sweep reports clean
for that camera. The header is never the weakest link in a layer that otherwise
works.

## The sting in the tail

Adding those 2 header rows moved the payload origin down by two cells. That
re-phased the entire cell grid against the sensor's resample grid, and the S1
sweep changed underneath it. That story is
[its own post](08-cell-grid-aliasing.md), and it is the best finding in the
project.

## A small doc/code divergence

`crates/core/src/fountain.rs` says each packet carries RaptorQ's own 4-byte FEC
Payload ID "so the frame header does not have to grow a sequence number". The
25-byte header nevertheless carries a `seq: u32`. Nothing reads it for fountain
purposes — the OTI plus the per-packet FEC ID is sufficient — so it appears to be
spare capacity rather than a contradiction, but the comment and the struct
disagree.
