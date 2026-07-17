# Ion Cost Model

This document defines the three cost granularities in the Ion engine and explains
how they map to observable fields in telemetry, the engine wire, the desktop UI,
and iOS.

## Granularities

### Turn cost

A **turn** is a single LLM call — one round of input tokens → output tokens. The
engine computes turn cost in `engine/internal/cost.TurnCost(model, usage)` using
cache-aware pricing:

| Token bucket | Rate |
|---|---|
| Regular input tokens | `CostPer1kInput / 1000` |
| Cache-creation tokens | `CostPer1kCacheCreation / 1000` (fallback: 1.25× input rate) |
| Cache-read tokens | `CostPer1kCacheRead / 1000` (fallback: 0.1× input rate) |
| Output tokens | `CostPer1kOutput / 1000` |

Cache rates come from the model registry (`engine/internal/providers/models.json`).
When a model lacks explicit cache pricing, the fallbacks apply:
- Cache-creation at 1.25× the base input rate (matches Anthropic's published write multiplier)
- Cache-read at 0.1× the base input rate (matches Anthropic's published read discount)

Turn cost is accumulated across all turns in a run into `conv.TotalCost`.

### Run cost

A **run** is one prompt-to-completion cycle initiated by a user prompt or an
async trigger. A run may span many LLM turns and may dispatch sub-agent runs.

**Run cost = sum of all turn costs within the run** (cache-aware, computed by
`cost.TurnCost` for every turn in the agent loop).

This is what the engine emits as:
- `StatusFields.runCostUsd` (engine_status wire field)
- `SessionStatus.runCostUsd` (engine_session_status wire field)
- `run.complete` telemetry payload's `runCostUsd` and `costUsd` keys

For the `CliBackend` (Claude Code CLI subprocess), run cost is delta-normalized:
the CLI reports a cumulative session total, and the engine subtracts the
previous cumulative to produce a per-run delta consistent with ApiBackend.

### Conversation cost

A **conversation** is the full lifetime of a conversation ID, including every
sub-agent dispatch that ran within it.

**Conversation cost = sum of all descendant run costs** across the dispatch tree,
computed by `cost.ConversationCost(convID, liveConvIDs, dir)`.

This uses a visited-set DFS walk over the conversation tree (`.tree.jsonl` files)
to sum `TotalCost` from each conversation's LLM header, counting each conversation
at most once (cycle-safe, dedup-safe).

This is what the engine emits as:
- `StatusFields.conversationCostUsd` (engine_status wire field)
- `SessionStatus.conversationCostUsd` (engine_session_status wire field)
- `context_breakdown` event's `aggregateCostUsd` field

## Observable fields

### Engine wire (`engine_status` / `engine_session_status`)

| Field | Scope | Notes |
|---|---|---|
| `runCostUsd` | Per-run | Cache-aware; replaces former `totalCostUsd` |
| `conversationCostUsd` | Full conversation | Dispatch-tree walk |

### `run.complete` telemetry payload

| Key | Scope | Notes |
|---|---|---|
| `runCostUsd` | Per-run | Canonical name |
| `costUsd` | Per-run | Alias; kept for compat |
| `aggregateCostUsd` | Full conversation | Dispatch-tree walk |

### Alloy structured_metadata (after alloy-config.alloy extraction)

| Key | Source field | Notes |
|---|---|---|
| `run_cost_usd` | `payload.runCostUsd` | Canonical cost for dashboard queries |
| `cost_usd` | `payload.costUsd` | Compat alias |
| `agg_cost_usd` | `payload.aggregateCostUsd` | Conversation-scope |

## Dashboard recipe

All cost panels should use:

```logql
sum(sum_over_time({kind="run.complete"} | json | unwrap run_cost_usd [<window>]))
```

This produces correct spend totals because:
1. Every run emits exactly one `run.complete` event
2. `run_cost_usd` is per-run, cache-aware, and dispatch-inclusive (no double-counting)
3. `agg_cost_usd` would double-count sub-agent runs that also emit `run.complete`

## Sub-agent tax panel

The sub-agent tax panel compares dispatch.agent events to run.complete events.
Both series must group by **`context_session_id`** (the engine session key from the
correlation context). Using `payload_session_id` on the dispatch.agent side and
`context_session_id` on the run.complete side produces a join-key mismatch that
silently drops rows.

## Why the rename

Before Commit 2 of the cost-centralization plan, `StatusFields.TotalCostUsd` was
misleadingly named — "total" implied conversation scope but it actually held run
scope. The rename to `RunCostUsd` makes the scope unambiguous, and adding
`ConversationCostUsd` as a distinct field provides the properly-scoped conversation
aggregate that was previously only available in the context breakdown event.
