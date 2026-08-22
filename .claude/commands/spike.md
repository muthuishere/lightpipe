---
description: Advance the transfer-qr spike ladder by exactly one step
---

You are running one iteration of the transfer-qr spike loop.

## Read first (cheap, do not skip)
1. `docs/spikes/PLAN.md` — the ladder and current STATUS values.
2. `docs/adr/README.md` — the decisions already closed. **Never silently contradict
   an accepted ADR.** If the work proves an ADR wrong, stop and write a superseding
   ADR instead of quietly doing something else.

## Pick exactly one spike
The first spike whose STATUS is `IN_PROGRESS`, else the first `PENDING`.
Do not start a second spike in the same iteration. Do not skip ahead.

## Do the work
- Code goes in `crates/core`. The core stays **pure** — no I/O, no DOM, no camera,
  no network (ADR-0009). Anything impure lives in a `src/bin/spikeN.rs`.
- Satisfy the spike's stated **Acceptance** criteria literally. If a criterion is
  ambiguous, make it concrete in `PLAN.md` first, then satisfy it.
- Every spike must leave: a passing `cargo test`, a `task spike:N` entry that a
  human can run, and a visual artifact in `artifacts/`.
- ADR-0011 is binding on every spike from S1 onward: a bad camera must still
  complete. If your change would make the potato-camera profile fail, that is a
  regression, not a tradeoff.

## Verify — this is the gate, not a formality
Run, and paste the real output:
```
task ci        # fmt + clippy -D warnings + tests
task spike:N   # the human-runnable path
```
If anything fails, fix it in this iteration. **Never mark a spike DONE on unverified
or partial work.** If it cannot be finished, leave it `IN_PROGRESS` and write down
precisely what is blocking it.

## Close the loop
1. Update the spike's STATUS in `docs/spikes/PLAN.md`, and **record the measured
   number** (SER, overhead %, KB/s) — not "works".
2. If the spike closed an option, add an ADR in `docs/adr/` and index it in
   `docs/adr/README.md`.
3. Append one line to `docs/spikes/LOG.md`: date, spike, measured result, surprises.
4. Commit: `spike(SN): <what was measured>`. Never add Co-authored-by.

## Report back
Three lines, no padding: what was measured, what it means for the design, what the
next spike is. If a result contradicts an assumption in an ADR, lead with that.
