# ADR-0010: Spike-first delivery, every stage runnable by a human

Status: Accepted · 2026-08-22

## Context
This project has several independent unknowns (colour fidelity, blur tolerance,
geometry recovery, fountain overhead, browser throughput). Building the product and
discovering them at integration time is the standard way these projects die.

## Decision
Deliver as an ordered ladder of spikes (`docs/spikes/PLAN.md`). Each spike:
1. proves exactly one unknown,
2. has automated tests (`task test`),
3. is runnable by any human via `task spike:N`,
4. emits a **visual artifact** (PNG / CSV in `artifacts/`) inspectable without
   reading Rust.

No spike before S6 may depend on physical hardware. The React app is S8 — last.

## Consequences
- Anyone (not just the agent that wrote it) can reproduce every result.
- Failure is cheap and early. If S1 shows P8 is unusable on blurred input, we learn
  it in a CSV on day one instead of in a room with two laptops in week six.
- Slightly more scaffolding up front (bins, Taskfile, artifact dirs).
