# ADR-0013: The frame header's `seq` is the chunk ordinal, and the manifest needs its own preamble

Status: Accepted · 2026-08-22 · Amends [ADR-0004](0004-fountain-codes.md) (header record semantics)

## Context

S2 fixed the 25-byte frame header as `magic · version · seq · payload_len · oti ·
crc32`. S3 then observed that RaptorQ packets are self-describing, so "the frame
header needs no sequence number — only the 12-byte OTI", and left `seq` unused.

Wiring the layers together end to end for the first time showed what that leaves
missing. ADR-0006 runs **one fountain per chunk**. The receiver therefore has to
answer, for every frame it decodes: *which chunk is this?* Nothing in the header
answers it:

- `oti` distinguishes chunks only by transfer length, and every full chunk of a
  transfer has the same length — 256 KB plain, or the same gzip member size by
  coincidence. It is not an identifier.
- The RaptorQ FEC Payload ID inside the packet carries a source **block** number,
  which is 0 for every chunk (one block per chunk, ADR-0004/S3).
- Chunk boundaries are implicit in time, so a receiver that joins mid-stream, or
  misses the transition, feeds packets of chunk 13 into the decoder of chunk 12 and
  gets a length-valid, CRC-valid packet that is simply wrong data. The fountain
  then fails to converge with no error, and the human sees a counter that stops
  counting down — which is exactly the "hang at 0%" failure ADR-0011 forbids.

## Decision

**`seq` is the chunk ordinal.** Every frame states which chunk of the manifest its
packet belongs to. The receiver demultiplexes on it, keeps one fountain per chunk,
and can join, leave, or re-join the broadcast at any point.

`u32` covers 4.29e9 chunks = 1 PB at the 256 KB default, so the field does not need
to grow.

## Consequences

- Chunk demultiplexing is explicit and free: the field already existed and was
  otherwise dead. No frame layout change, so the S1/S2/S4 rate ladder is **not**
  invalidated (S2's warning: any layout change re-phases the cell grid and
  invalidates the sweep).
- Resume (ADR-0005) now has a wire-level meaning: the typed `chunk` in the resume
  code selects the `seq` the sender restarts at, and the receiver can verify it is
  receiving what it asked for rather than trusting sequence in time.
- The receiver may keep several chunk fountains alive at once, which costs one
  decoder state per in-flight chunk. Bounded by policy, not by the protocol.
- A frame from a *different transfer* is still indistinguishable from one of ours
  beyond the CRC. That is out of scope here; note it if two senders can ever be in
  frame at once.

## Open gap, deliberately not decided here

**The manifest is still out-of-band.** Everything in `pipeline.rs` — chunk count,
chunk sizes, per-chunk BLAKE3, the whole-file BLAKE3 behind the display code — is
assumed to be already on the receiver, and the end-to-end run hands it over
in-process. Nothing in the frame format carries it, so as of today the optical link
transfers a file *only if the receiver was told the manifest some other way*.

That is the largest hole integration exposed. It needs its own decision (a reserved
`seq` value for a manifest preamble, its own fountain, repeated forever so a
late-joining receiver can pick it up), and it needs sizing: 44 B per chunk means
180 KB of manifest for a 1 GB transfer, which is itself a transfer — on the potato
rung that is 153 frames, 10 s at 15 FPS, before the file starts. Do not paper over
it with "the receiver has the manifest".

## Alternatives rejected

- **Widen the header with a new chunk field** — a layout change, and S2 measured
  that moving the payload origin costs a whole rung of the ladder. `seq` was already
  there and already unused.
- **Infer the chunk from the OTI** — chunks are not distinguishable by length.
- **Send chunks strictly in order and infer from time** — works only for a receiver
  that starts before the first frame and never misses a transition, which is exactly
  the case the no-back-channel design cannot guarantee.
