# ADR-018: Centralize cost calculation and rename StatusFields cost fields

**Status:** Accepted  
**Date:** 2025-07-06  
**Authors:** Josh Sprague

## Context

The Ion engine had three independent cost computation paths that each reimplemented
the cost formula:

1. `backend/runloop_helpers.go` → `computeCost()` (non-cache-aware)
2. `session/extcontext/llm_call.go` → `computeLLMCallCost()` (same formula, separate copy)
3. `session/aggregate_cost.go` → `ComputeAggregateCost()` (conversation walk)

All three used only `CostPer1kInput` + `CostPer1kOutput` and silently produced
incorrect cost figures for models that support prompt caching (e.g. Anthropic
Claude 3.x / 4.x). Cache-creation tokens (written into the cache) cost 1.25× the
base input rate; cache-read tokens cost only 0.1× the base input rate. Not
accounting for these buckets underpriced sessions that used caching heavily.

Additionally, `StatusFields.TotalCostUsd` was misleadingly named — "total" implied
conversation scope but the actual value was run-scoped (accumulated across the turns
of one prompt-to-completion cycle). This prevented the dashboard from distinguishing
per-run spend from per-conversation spend.

## Decision

### 1. New package: `engine/internal/cost`

A single authoritative package owns all cost math:

- **`TurnCost(model string, usage types.LlmUsage) float64`** — cache-aware per-turn
  cost atom. Uses `CostPer1kCacheCreation` and `CostPer1kCacheRead` from the model
  registry, with fallbacks (1.25× input creation, 0.1× input read) when explicit
  rates are absent. The fallback values match Anthropic's published cache pricing
  tiers and apply only to models that lack explicit entries in `models.json`.

- **`ConversationCost(convID string, liveConvIDs []string, dir string) (float64, error)`**
  — conversation-scope aggregate, moved verbatim from `session/aggregate_cost.go`.
  Preserves the visited-set dedup and best-effort disk-walk error handling.

All three call sites are rewired:
- `backend/runloop_helpers.go` `computeCost` → `cost.TurnCost`
- `session/extcontext/llm_call.go` `computeLLMCallCost` → `cost.TurnCost`
- `session/event_translation.go` `ComputeAggregateCost` → `cost.ConversationCost`
- `session/manager_context_breakdown.go` `ComputeAggregateCost` → `cost.ConversationCost`

`session/aggregate_cost.go` is deleted; the duplicate `computeLLMCallCost` is
deleted; the drift between the two cost formulas is eliminated.

### 2. Engine-wire rename: `TotalCostUsd` → `RunCostUsd` + add `ConversationCostUsd`

`StatusFields` and `SessionStatus` gain:
- `RunCostUsd` (formerly `TotalCostUsd`) — per-run, cache-aware, descendants included
- `ConversationCostUsd` — full dispatch-tree aggregate from `cost.ConversationCost`

This is an operator-approved breaking change to the scrutinized engine wire,
committed as `fix` per the naming-correction precedent in `engine/AGENTS.md`.
All three in-repo clients (desktop, iOS) update in the same PR under the lockstep
model.

### 3. `run.complete` telemetry: add `runCostUsd`

The `run.complete` telemetry payload gains a `runCostUsd` field (alias for `costUsd`
with the correct scope name). Dashboard queries should migrate to `run_cost_usd` in
Alloy structured_metadata; `cost_usd` and `agg_cost_usd` remain for compatibility.

### 4. CliBackend delta-normalization

The Claude Code CLI reports `total_cost_usd` as a session-cumulative value. Before
this ADR, the engine forwarded the raw cumulative as `CostUsd`, producing inflated
run costs on multi-run sessions. `CliBackend` now tracks `lastCumulativeCost` per
session key and subtracts on each `TaskComplete` so `CostUsd` (and therefore
`RunCostUsd`) has the same per-run semantics as `ApiBackend`.

### 5. Model registry: add cache pricing fields

`types.ModelInfo` gains `CostPer1kCacheCreation` and `CostPer1kCacheRead`
(`omitempty`, zero triggers the fallback). `models.json` catalog entries and user
model config parsing carry the new fields. No existing models.json entry sets these
yet; the fallbacks apply universally until explicit rates are added.

## Consequences

### Positive

- Single, correct cost formula. No drift between backends.
- Cache-aware pricing: sessions that use prompt caching now produce correct
  (lower) cost figures instead of overpriced ones.
- `RunCostUsd` vs `ConversationCostUsd` makes the scope unambiguous to clients.
- The dashboard can accurately distinguish per-run spend from per-conversation spend.
- The sub-agent-tax panel's join-key mismatch (`payload_session_id` vs
  `context_session_id`) is corrected; both series now group by `context_session_id`.
- CliBackend cost is per-run delta (matches ApiBackend semantics).

### Negative / risks

- Breaking engine wire change (`TotalCostUsd` → `RunCostUsd`). Any external client
  that reads `totalCostUsd` from `engine_status` must update. The rename is an
  operator-approved exception to the no-breaking-change rule.
- The lockstep desktop + iOS update ships in the same PR, eliminating the window
  where one side has the old field and the other has the new one.
- Cache pricing fallbacks (1.25× creation, 0.1× read) are best-effort estimates
  for models without explicit `models.json` entries. They will be wrong for
  providers that use different multipliers (e.g. Google's Gemini context caching
  uses different rates). The fallbacks are labeled as assumptions; adding explicit
  rates per-model is the long-term fix.

## Alternatives considered

### Option A: Keep `TotalCostUsd`, add `ConversationCostUsd` as new field

Keep the existing field name and add the new one alongside. Avoids the wire break
but leaves `totalCostUsd` with misleading "total" scope semantics indefinitely.
Rejected: the misleading name would continue to cause incorrect dashboard queries.

### Option B (chosen): Rename `TotalCostUsd` → `RunCostUsd` + add `ConversationCostUsd`

Clean scope-accurate names from day one. Wire break is contained to a single PR
with all in-repo consumers updated. External consumers are rare (the engine is
pre-1.0); the risk is low relative to the benefit of a correct name.

## References

- `engine/internal/cost/cost.go` — authoritative implementation
- `docs/observability/cost-model.md` — observable fields reference
- `engine/internal/types/types.go` — `StatusFields`, `SessionStatus`
- `engine/internal/session/event_translation.go` — run.complete telemetry payload
