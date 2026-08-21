---
title: "ADR-002: Engine vs Harness for Early-Stop Continuation"
description: Engine provides the mechanism. Harness owns the policy and the prompt text.
sidebar_position: 2
---

# ADR-002: Engine vs Harness for Early-Stop Continuation

## Status

Accepted

## Date

2026-05-24

## Context

Early-stop continuation is a behavior that nudges a model to keep working when it appears to be ending a turn prematurely — typically detected by tracking cumulative output tokens against a budget and noticing the model emitted `end_turn` or `stop` well before the budget was exhausted. The feature originated as a port of Claude Code's `TOKEN_BUDGET` nudge.

The initial implementation landed in the engine with three sharp edges:

1. **Default-on.** Every session that started against an engine binary inherited the nudge behavior whether the harness wanted it or not. A third-party harness that explicitly preferred to let the model end its turn could not opt out without overriding the engine's config.
2. **Engine-baked prompt text.** A `defaultEarlyStopContinueMessage` constant carrying Claude-Code-derived English prose lived in `engine/internal/backend/runloop_early_stop.go`. Every continuation nudge sent this exact string to the model, regardless of the harness's tone, language, or domain conventions.
3. **Engine-side formatting helpers.** The engine carried a `formatTokens` helper to render numbers like `8,000 / 10,000` for inclusion in the prompt. Number formatting is a presentation concern; it has no place in a headless engine.

All three violate [ADR-001's](./001-engine-vs-harness.md) core boundary: the engine is supposed to provide *mechanism* (token tracking, threshold comparison, the decision hook), and the harness is supposed to own *policy* (whether to nudge, what to say). The feature shipped on the wrong side of the line.

Compounding the issue, the engine emitted `before_early_stop_decision` as a subprocess-only extension hook. The desktop — the canonical socket-only harness — could not participate in the decision without spawning a subprocess extension purely to register one hook. That worked against the principle that socket-only harnesses should be first-class participants in any decision the engine wants external input on (the same principle that motivated `permission_request` ↔ `permission_response` and `elicitation_request` ↔ `elicitation_response`).

## Decision

**The engine provides the mechanism. The harness provides the policy and the prompt text.**

### Engine responsibilities (retained)

| Concern | Rationale |
|---------|-----------|
| Cumulative output token tracking | Mechanical accounting; identical for every harness |
| Threshold comparison and decision math | Mechanical; the harness should not have to reimplement it |
| `before_early_stop_decision` hook firing | The harness's policy hook |
| `early_stop_continued` hook firing | Observability for the harness |
| Numeric tuning defaults (8000 / 90% / 3 / 500) | Sensible fallbacks; can be overridden at every layer |
| Re-run-turn machinery | Engine-internal; the loop must know how to continue a run |
| `engine_early_stop_decision_request` wire event | Promotes the hook to the socket so non-subprocess harnesses can respond |

### Engine responsibilities (removed)

| Concern | New owner | Rationale |
|---------|-----------|-----------|
| The default `ContinueMessage` text | Harness | Prompt prose is a policy decision; engine is not a Claude Code port |
| `formatTokens` helper | Harness | Presentation logic — number formatting is a UI/text concern |
| Default-on enablement | Harness | The harness opts in by responding to the decision hook or by overriding `engine.json` |

### Default behavior

`engine.json` ships with `earlyStopContinue.enabled: false`. When disabled, the engine never fires the decision hook and never blocks on the wire-protocol round trip. The model's `end_turn` is honored as-is and the run completes normally.

When enabled, the engine:

1. Tracks cumulative output tokens.
2. On model `end_turn` / `stop` below the threshold, fires `before_early_stop_decision` (extension subprocess hooks first).
3. If no extension expressed an opinion, emits `engine_early_stop_decision_request` on the wire and blocks on a channel with a 100ms timeout.
4. Merges the response (extension or wire) into a final decision.
5. If the resolved decision is "continue" **and** a `ContinueMessage` was supplied (by the hook or the wire response), injects the message and re-runs the turn.
6. If "continue" was resolved but **no** `ContinueMessage` was supplied by any source, logs `earlyStop: enabled but no ContinueMessage supplied; skipping injection` and falls through to normal `TaskComplete` emission.

The "no message → skip" path is the safety valve that prevents an enabled-but-unconfigured engine from forcing the model into an infinite loop.

### Three-layer disable

| Layer | Owner | When to use |
|-------|-------|-------------|
| `engine.json` `earlyStopContinue.enabled = false` | Operator / config author | Harness-less and harness-with-config deployments |
| `before_early_stop_decision` returns `ForceContinue: &false` | Extension author | Per-run policy in a subprocess extension |
| Wire-protocol response with `forceContinue: false` | Socket-only harness | Per-run policy in a socket-only harness (desktop, custom UIs) |

### Reference policy implementation

The desktop ships [`desktop/src/main/early-stop-policy.ts`](https://github.com/dsswift/ion/blob/main/desktop/src/main/early-stop-policy.ts) as the reference policy. It listens for `engine_early_stop_decision_request` on the bridge, reads the `enableEarlyStopContinuation` setting from the desktop's settings store, and:

- Setting off → responds with `forceContinue: false` (explicit no-nudge).
- Setting on + `wouldContinue` true → responds with a static Claude-Code-style `continueMessage`.
- Setting on + `wouldContinue` false → responds empty (no opinion).

Third-party harnesses can copy this module verbatim or build their own.

## Consequences

### Positive

- Engine code is UI-agnostic again — no English prose, no number formatting, no Claude Code lineage in operational logs.
- Third-party harnesses get an explicit opt-in; nothing surprises them at runtime.
- Socket-only harnesses are first-class participants via the new wire-protocol round trip — they don't need a subprocess extension just to register one hook.
- The reference desktop policy is ~80 lines and easily copyable for new harnesses.
- The numeric tuning knobs (budget, thresholdPct, maxContinuations, diminishingDelta) stay configurable at all three layers, so calibration is unchanged.

### Negative

- Breaking change for existing engine consumers that relied on the default-on Claude-Code-style nudge. Migration: set `enableEarlyStopContinuation: true` in the desktop UI, or wire the `before_early_stop_decision` hook directly.
- The desktop carries text that previously lived in the engine. That's the right place for it, but it does mean the desktop and any third-party harness both ship their own copy of similar prose. Acceptable: prose is policy; duplicating policy is the cost of decentralizing it.

### Migration

For consumers depending on the previous default-on behavior:

1. **Desktop users:** Toggle "Early-stop continuation nudge" on in the General settings tab. The setting defaults to `false` for all installs; users who want the Claude-Code-style nudge behavior opt in explicitly.
2. **Third-party harnesses:** Implement `before_early_stop_decision` (subprocess) or respond to `engine_early_stop_decision_request` (socket). Return a `ContinueMessage` string suited to the harness's domain.
3. **Operators running the engine without a harness:** Add a `before_early_stop_decision` hook in a minimal extension, or accept that early-stop continuation will not fire (the safest default).

## Related

- [ADR-001](./001-engine-vs-harness.md) — the parent principle this ADR concretely applies.
- [ADR-003](./003-state-events-vs-workflow-events.md) — same lesson applied to plan-mode events.
- [ADR-004](./004-enter-plan-mode-prose-in-harness.md) — same lesson applied to the `EnterPlanMode` tool description.
- [`docs/hooks/reference.md`](../../hooks/reference.md) — full reference for the `before_early_stop_decision` hook.
- [`docs/configuration/engine-json.md`](../../configuration/engine-json.md) — `earlyStopContinue` configuration block.
- [`docs/engine-grounding.md`](../../engine-grounding.md) — house rules including "engine executes, harness decides."

## Amendments

- **2026-05-25.** Removed the upgrader carve-out from the Migration section ("defaults to `true` for users upgrading from a build with the old engine"). The early-stop continuation feature never shipped to `main` — there is no prior engine binary that carried it, so there are no upgraders whose behavior could regress. The setting now defaults to `false` everywhere; users opt in explicitly through the General settings tab. This keeps the engine-vs-harness boundary clean (engine never assumes the harness wants the nudge) without inventing a migration story for a behavior that has no install base.
- **2026-08-20.** Clarified the operator-cost rationale for default-off. A continuation consumes the operator's tokens and pre-empts their choice to accept a stopped run and decide what to do next. The engine therefore ships a configurable mechanism, not an automatic recovery policy. Early-stop continuation is also not a remedy for an engine-side dropped tool call: when a turn carries a tool call, the engine must execute it regardless of a contradictory terminal stop reason. A nudge would add tokens and hide the mechanical defect instead of fixing it.
