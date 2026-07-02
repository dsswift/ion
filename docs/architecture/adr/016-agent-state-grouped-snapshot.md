---
title: "ADR-016: engine_agent_state Grouped-Snapshot Projection"
description: Same-name engine dispatches are grouped into one representative AgentStateUpdate row; per-dispatch identity is preserved in metadata.dispatches[].
sidebar_position: 16
---

# ADR-016: engine_agent_state Grouped-Snapshot Projection

## Status

Accepted

## Date

2026-07-02

## Context

`engine_agent_state` emits a complete snapshot: consumers replace their local
view with the payload on every emission. That contract is unchanged.

Before this change the snapshot was a flat list of `AgentStateUpdate` rows
where each engine-managed dispatch produced one row keyed by its internal
dispatch ID. When the orchestrator dispatched the same agent name more than
once in a session (e.g. two sequential `cloud-architect` dispatches), the
snapshot carried two rows with the same `name` field. Consumers iterating
top-level rows to render a list of agents saw duplicate entries for the same
agent name with no structural way to collapse them — the duplication was in the
data, not in rendering policy.

## Decision

The `engine_agent_state` snapshot stays a **complete replace-not-merge
snapshot** (invariant unchanged). The engine now applies a grouped projection
before emitting: same-`name` entries are merged into a single representative
`AgentStateUpdate` row whose `metadata.dispatches[]` carries the per-dispatch
detail from every contributing entry.

The projection lives in `engine/internal/session/agents/registry.go`:

- `MergedSnapshot()` (~L340) — public entry point; applies the name-grouping
  projection on top of the existing extension-vs-engine supersede logic.
- `groupByName()` (~L450-571) — groups the engine-managed `[]AgentStateUpdate`
  slice by `Name`. For each group, picks a representative (highest-priority
  status: running > error > done > cancelled; ties broken by last-added
  position), deep-copies its metadata, then merges `metadata.dispatches[]`
  arrays from all entries in order, de-duplicating by each member's stable
  `"id"` field.
- `ensureDispatchIdentity()` / `ensureDispatchIdentitiesInMeta()` (~L652-700)
  — stamps explicit `dispatchId` (mirrored from `"id"`) onto each
  `dispatches[]` member so per-dispatch identity is preserved after grouping.
  Additive and idempotent: no existing key is removed.

The internal `r.states` map remains ID-keyed and untouched. `UpdateStateByID`
and `AppendOrUpdateByID` continue to target individual dispatches by their
stable engine-minted ID. The grouping is a projection-only operation that runs
at snapshot-emit time.

## Struct and field reference

`AgentStateUpdate` (`engine/internal/types/types.go`):

| JSON field | Go field | Notes |
|------------|----------|-------|
| `name`     | `Name`   | Agent name; the grouping key |
| `id`       | `ID`     | Engine-minted dispatch ID (omitempty) |
| `status`   | `Status` | running / done / error / cancelled |
| `metadata` | `Metadata` | `map[string]interface{}` carrying per-dispatch detail |

`metadata` keys used by the projection:

| Key | Type | Notes |
|-----|------|-------|
| `dispatches` | `[]interface{}` | Per-dispatch entries; each member is a `map[string]interface{}` |
| `task` | `string` | Present on engine dispatch rows; absence marks a roster-only row |

Each `dispatches[]` member after projection carries:

| Key | Notes |
|-----|-------|
| `id` | Stable engine-minted dispatch ID; the de-dup key |
| `dispatchId` | Mirrored from `id` by `ensureDispatchIdentity`; the field consumers key on to address individual dispatches |
| `dispatchParentId` | Present when persisted/rehydrated from conversation file; absent for top-level dispatches |
| `dispatchDepth` | Same persistence provenance as `dispatchParentId` |
| `status` | Per-dispatch status; passed through as-is |

## Consequences

- **Consumer view:** iterating top-level `engine_agent_state` rows yields one
  row per agent `name`. Per-dispatch detail is available in
  `metadata.dispatches[]` on each row.
- **Replace-snapshot contract unchanged.** Consumers still replace their local
  agent list on every `engine_agent_state` emission. The grouping does not
  introduce incremental-update semantics.
- **Per-dispatch addressability preserved.** `metadata.dispatches[]` members
  carry explicit `dispatchId` values so consumers can address individual
  dispatches without knowing the internal ID-keyed store layout.
- **Single-dispatch case.** An agent with exactly one dispatch still goes
  through `ensureDispatchIdentitiesInMeta` so its `dispatches[]` member
  carries `dispatchId`. The projection is uniform across group sizes.
- **Pathological shape detection.** `groupByName` logs a `Debug` entry when a
  dispatch-bearing representative row (one with a non-empty `metadata.task`)
  ends up with an empty `metadata.dispatches[]`. This is the shape consumers
  cannot expand per-dispatch detail from. The log line is the diagnostic
  signature for that failure mode.
