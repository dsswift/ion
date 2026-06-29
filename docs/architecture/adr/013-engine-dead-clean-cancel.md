---
title: "ADR-013: engine_dead Reserved for Abnormal Termination"
description: A cooperative cancel is a clean, recoverable exit. engine_dead fires only on abnormal termination.
sidebar_position: 13
---

# ADR-013: `engine_dead` Reserved for Abnormal Termination

## Status

Accepted

## Date

2026-06-27

## Context

`engine_dead` is the engine's signal that a backend run process exited. Historically it fired for **any** non-normal exit: a non-zero exit code, or any terminating signal — **including the cooperative `cancelled` signal** the engine itself raises when a run is interrupted on purpose.

A cooperative cancel is not a crash. It is raised when:

- A user or auto abort interrupts the run (`SendAbort`).
- A turn-start / turn-end / tool hook cancels the run from inside the runloop.
- A higher-level watchdog asks the run to stop.

In all of these the conversation is intact, the session is immediately reusable, and nothing has died. Firing `engine_dead` on that path made a deliberately interrupted-but-recoverable run look like a backend crash. The concrete failure was the `1782088921498-960b064fe896` incident: the stuck-tab watchdog's abort raised a cooperative `cancelled`, the engine emitted `engine_dead`, and a perfectly recoverable run surfaced to the user as a dead session.

Every consumer that had been bitten by this learned to special-case `engine_dead` with `exitCode==0` into a no-op, which is the tell that the engine was emitting a signal it should not have emitted on that trigger. The deeper problem is the same one ADR-003 identified: an event was firing on a trigger that did not match its semantic role. `engine_dead` means *death*; a cooperative cancel is *not* death.

## Decision

**`engine_dead` is reserved for ABNORMAL termination.**

- **Fires** when the run process exits with a non-zero code, or terminates on any signal *other than* the cooperative `cancelled` (e.g. `SIGKILL`, `SIGSEGV`, or the watchdog's `cancelled-forced` hard kill). These are real deaths a consumer must surface.
- **Does not fire** on a clean cancel — `exitCode` is `0` (or null) and `signal` is `"cancelled"`. That path emits the idle `engine_status` and reaps descendant agents (every code path that ends an agent's run still transitions the registry to a terminal status, per the snapshot contract), but it emits no `engine_dead`.

### Semantic rationale

A cooperative cancel is a clean, recoverable exit, not a death. The conversation is intact and the session is immediately reusable on the next prompt. Surfacing it as `engine_dead` overloads the event with a second, contradictory meaning ("the run stopped on purpose and you can keep going") that the wire shape gives consumers no way to distinguish from a real crash except by inspecting `exitCode` — exactly the defensive guard this change removes the need for.

### Descendant teardown is independent of the `engine_dead` decision

Reaping dispatched child agents runs for *any* non-normal exit — clean cancel or abnormal death — regardless of whether `engine_dead` is emitted. A clean cancel can arrive straight from the runloop without flowing through `SendAbort`, so the `SendAbort`-side descendant teardown is not guaranteed to have fired; `handleRunExit` reaps descendants on the clean-cancel path to ensure no dispatched child outlives a cancelled parent. The per-path agent-state snapshot guarantee for this path is pinned in `engine/internal/session/manager_agent_lifecycle_test.go`.

## Consequences

### Positive

- `engine_dead` carries exactly one meaning: abnormal termination. Consumers no longer special-case `exitCode==0` to suppress a false death.
- A cooperative cancel is observable through the idle `engine_status` that always precedes it; consumers detect "the run stopped, the session is reusable" without inferring it from a `engine_dead` they then have to discard.

### Negative

- **Trigger-set change to a published wire event.** An external consumer that treated *any* `engine_dead` as terminal — including a clean cancel — must now also observe the idle `engine_status` (and the absence of further run activity) to detect a cancel. The wire shape of `engine_dead` is unchanged; only the set of triggers that fire it narrowed. Per the engine-grounding "Forbidden (breaking)" rule, stopping the emission of an existing event on one of its established triggers is a breaking change even when the wire shape is unchanged, and requires an ADR documenting the semantic rationale and migration impact. This ADR is that record. Shipped as `fix(engine)` per the engine wire-contract correction allowance.

## Related

- [ADR-003](./003-state-events-vs-workflow-events.md) — the precedent: a trigger-set change ratified by ADR (the `ExitPlanMode` trigger removed from `engine_plan_mode_changed`). This ADR applies the same discipline to `engine_dead`.
- [`docs/architecture/agent-state.md`](../agent-state.md) — the snapshot contract the clean-cancel descendant teardown honors.
- [`docs/protocol/server-events.md`](../../protocol/server-events.md) — the `engine_dead` wire reference, updated with the clean-cancel exclusion.
- [`docs/engine-grounding.md`](../../engine-grounding.md) — the "stop emitting on an established trigger" forbidden rule that requires this ADR.
