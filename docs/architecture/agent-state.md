---
title: Agent State Contract
description: Normative semantics for engine_agent_state — the engine emits complete snapshots; consumers replace local state.
sidebar_position: 5
---

# Agent State Contract

`engine_agent_state` is one of the engine's primary event types. This document is the normative reference for its semantics. It applies equally to:

- The engine's own emission sites (Agent tool spawner, session lifecycle, host death recovery).
- Extension-emitted state via `ctx.emit({ type: 'engine_agent_state', ... })`.
- All consumers: desktop renderer, iOS client, any future headless harness.

If any part of the system disagrees with this document, the document wins. File a bug.

## The contract

> Every `engine_agent_state` event is a **complete snapshot** of every agent the engine considers live at that instant. Consumers replace their local agent view with the payload — they do **not** merge, do **not** preserve entries not present in the snapshot, and do **not** invent retention rules.

That's it. Three sentences. The rest of this document is consequences.

## What this means for emitters

The engine guarantees that every code path which ends an agent's run emits a follow-up `engine_agent_state` where the affected agent either:

- Appears with a terminal status (`done`, `error`, `cancelled`), **or**
- Is absent from the snapshot because the engine has dropped its registration.

There is no third option. An agent must not silently transition out of "running" without an emission. Termination paths include:

- Normal completion (`prompt_agent_spawner.go` after child backend exit).
- User-initiated abort (`SendAbort` → `abortAllDescendants`).
- Parent run failure (`handleRunError`, `handleRunExit` with non-zero code).
- Plan-mode abort.
- Backend disconnection mid-run.
- Extension subprocess death (the engine emits a corrective snapshot from its own registry; see "Recovery" below).

Tests in `engine/internal/session/manager_agent_lifecycle_test.go` enforce these guarantees per path.

## What this means for consumers

When you receive `engine_agent_state`:

1. **Replace your local store with the payload.** Whatever you had before is irrelevant; the engine just told you what is live now.
2. **An empty `agents: []` array means no agents are live.** Drop every entry. This is not a "no-op" signal — it is the authoritative "wipe your view" signal.
3. **Do not invent retention rules.** Specifically, do not keep entries that "look historical" (status != running, has a `conversationId`, etc.). If the engine wanted you to see them, the engine would have included them in the snapshot.
4. **If you need a "past dispatches" feature, build it on conversation history.** Conversation messages are persisted separately and are an appropriate source of truth for "what did this agent say last time." Agent state is not.

This rule existed implicitly for a long time. The desktop renderer briefly violated it with a "preserve historical" branch in `engine-event-slice.ts`, and the bug surfaced as stale agent rows on iOS reconnect (the desktop's preserved-but-stale state was being forwarded to the mobile client via `sendCurrentEngineState`). The rule is now explicit and tested.

## Recovery: extension death

When an extension subprocess dies, the engine cannot trust the extension's last-emitted state. Agents the extension said were "running" may be running, dead, or in any other state — the only honest answer is "we don't know what the extension thinks anymore."

The engine handles this by:

1. Emitting `engine_extension_died` (typed event with exit code and signal).
2. Dropping the extension's cached snapshot (`Registry.CacheExtStates(nil)`).
3. Emitting `engine_agent_state` with the engine's own registry view — which contains only engine-managed Agent tool sub-agents, not the dead extension's agents.

This means: on extension death, consumers see the extension's agents disappear from the snapshot. When the extension respawns and re-emits its state via `session_start`, the snapshot is repopulated naturally.

Recovery stays inside the engine. Consumers remain dumb replace-receivers — they never need defensive demotion logic of their own.

## Recovery: reconnecting clients

When a client (re)connects, the engine bridge calls `ReconcileState(key)`. This unconditionally emits the current `engine_agent_state` snapshot — even the empty one. A reconnecting client must learn the truth as much as a long-connected one needs the next live update.

Consumers that skip "empty payload" emissions (whether at the engine, bridge, or client layer) silently break this contract. The desktop's `sendCurrentEngineState` previously had such a skip; it has been removed.

## Status values

Known values for `AgentStateUpdate.status`:

| Status | Meaning |
|---|---|
| `idle` | Registered but not currently running (typically chiefs/sticky agents waiting for dispatch). |
| `running` | Active LLM stream in flight. |
| `done` | Completed normally. |
| `error` | Terminated with an error (see `metadata.lastWork` for details). |
| `cancelled` | Aborted by user, parent, or system. |

Consumers should accept any string and degrade gracefully on unknown values (render as a generic "non-running" row). The engine guarantees `running` is the only non-terminal status; everything else implies the agent is no longer consuming model budget.

## Well-known metadata keys

`AgentStateUpdate.metadata` is an open-ended map. The engine and SDK reserve no keys, but harnesses and clients have settled on a small vocabulary. Consumers render what they understand and ignore the rest.

| Key | Type | Purpose |
|---|---|---|
| `displayName` | string | Human-friendly name to show in UI. |
| `type` | string | One of `chief`, `specialist`, `staff`, `consultant`, `agent` (harness-defined; `agent` is the engine's default for Agent tool sub-agents). |
| `visibility` | string | One of `always`, `sticky`, `ephemeral`. Hints to the client about which agents to show when idle. |
| `invited` | bool | True when the agent has been dispatched at least once in this session. Used together with `sticky` visibility. |
| `color` | string | CSS color string for the agent's identity badge. |
| `model` | string | Provider model id (e.g. `claude-sonnet-4-6`). |
| `task` | string | The prompt the orchestrator handed to this agent. |
| `lastWork` | string | Short summary of the agent's last activity. Producers should keep this to roughly a line; the engine bounds it (see "Metadata size bounds"). |
| `fullOutput` | string | Full agent output (clients may render or hide). |
| `elapsed` | number | Wall-clock seconds since `startTime`. |
| `startTime` | number | Unix timestamp (seconds) when the agent started its current run. |
| `cost` | number | Cumulative USD cost for this agent's runs in this session. |
| `conversationId` | string | Backend session id for "rewind into this agent's transcript" features. |
| `parentAgent` | string | Name of the dispatching agent (for tree views). |
| `depth` | number | Nesting depth from the root run. |

The list is advisory. Extensions are free to add their own keys; pick a unique prefix to avoid collisions.

Keys beginning with `_` are reserved by the engine (see `_truncated` below).

## Metadata size bounds

`metadata` is an open-ended map, and because this event is a **complete snapshot** an oversized value is paid on *every* emission for the life of the session rather than once. The engine therefore bounds an **outbound deep-copy projection**. Registry state remains full fidelity for persistence, dispatch lifecycle updates, and on-demand retrieval.

This is not theoretical. A 36,969,872-byte `engine_agent_state` carrying only 11 agents (~3.3 MB each) was rebuilt byte-identical for over 15 hours. It exceeded the desktop's 6 MiB transport cap on all 1,873 attempts, so it was dropped every time — iOS went blind to agent state for the entire window while the desktop burned CPU rebuilding an undeliverable frame. The engine had written all 35 MB to the NDJSON socket regardless, so every external wire consumer paid for it too.

The tiers are configurable under `limits.agentStateMetadata` in `engine.json` (`0` = default, `-1` = disabled), with an enterprise ceiling that is minimum-wins:

| Tier | Default | Catches |
|---|---|---|
| `maxValueBytes` | 4096 | one giant string |
| `maxEntryBytes` | 65536 | death by a thousand keys |
| `maxSnapshotBytes` | 4 MiB | an agent-*count* explosion |
| `maxDepth` | 4 | nested structures |
| `maxDispatchEntries` | 50 | an unbounded dispatch *history* |

`maxDispatchEntries` exists because a byte tier cannot see a history coming: `dispatches[]` accumulates one small record per Agent-tool dispatch (and rehydrates across restarts), so no single value ever trips `maxValueBytes` while the array grows without bound. The emitted snapshot keeps the most recent entries, stamps the original count as `dispatchesTotal`, and marks the cut in `_truncatedKeys`. The full history remains in conversation storage and producer persistence — a complete-snapshot event carries live status, not an archive.

**The entry and snapshot bounds preserve routing identity over a numeric ceiling.** The entry budget drops unprotected keys largest-first, then shrinks protected collections while retaining at least the newest complete dispatch entry. The final backstop can replace optional protected display metadata, but never dispatch IDs, conversation IDs, `dispatches[]`, visibility, invitation state, or type. If identity alone exceeds a configured budget, the engine logs the overage and ships a correct projection rather than a corrupt one.

Rules the clamp obeys, which consumers may rely on:

- **An agent is never dropped**, only metadata. Omitting an agent from a complete snapshot means "this agent is gone", so shedding one to save bytes would be a lie.
- **Protected keys are never removed or structurally corrupted.** The bounded broadcast may UTF-8-truncate an oversized scalar and marks the affected key in `_truncatedKeys`, but it never replaces an array or map with a marker or changes a key's JSON type. A dispatch member remains an addressable object; when no complete member fits, the projection carries an empty `dispatches[]` plus `dispatchesTotal`, and a consumer requests exact data with `get_agent_state`.
- **`visibility` and `invited` are protected for a cross-client reason.** iOS defaults an absent `visibility` to `ephemeral` and renders ephemeral agents only while running; an absent `invited` defaults to `false`, which hides `sticky` rows. Dropping either would silently empty the agents panel — a wrong render that looks successful, which is worse than a dropped frame.
- **Truncation is UTF-8 safe.** A byte-slice cut would emit invalid UTF-8 and make the whole frame undecodable, turning a large snapshot into no snapshot.
- **`dispatches[]` keeps its most recent entries**, each recursed into rather than flattened, because per-dispatch UI state is keyed on the `id` / `status` / `conversationId` inside it. When the array is cut, `dispatchesTotal` carries the pre-cut count.

### `_truncated` / `_truncatedKeys`

When the engine clamps an entry it stamps `_truncated: true` and `_truncatedKeys: [...]` into that agent's metadata, and separately emits `engine_agent_state_clamped` carrying key names and byte counts (never the content — echoing the offending value would recreate the pathology in a second event).

These are **not** redundant surfaces for one signal, which the typed-event rule would otherwise forbid. The event answers "a clamp happened in this session and here is how much was lost". The in-band marker answers "*this* value on *this* agent in *this* snapshot is not what the producer wrote" — which is what a consumer needs to render an ellipsis or a tooltip, and which cannot be reliably reconstructed by correlating an out-of-band event back to one field of one agent inside one snapshot.

The advisory is rate-limited per `(agent, scope)`; every clamp is logged at WARN regardless, so log-based diagnosis stays complete.

### Dispatch transcript durability

`dispatches[].conversationId` is always a loadable Ion conversation-history key, even when the dispatched child runs on a delegated backend whose native session is stored outside Ion. Native-session child events are mirrored into Ion conversation storage under that published ID: task, assistant text, tool calls, and tool results persist incrementally, and terminal output is the fallback when a backend exposes no text stream. Engine-owned child backends already persist their own file and remain authoritative.

Conversations written before this mirror existed are repaired during dispatch-state rehydration. The engine recovers full terminal output from persisted parent `agent_completion` turns or foreground Agent tool results and materializes the missing child file without rewriting the parent conversation. Clients therefore use one mechanism for live and historical dispatches: read the ID from `dispatches[]`, then call `get_conversation`.

### Persisted dispatch lifecycle precedence

Dispatch registration writes a durable `running` record before a child starts. A terminal transition later writes a superseding record with the same dispatch ID, status, elapsed time, and child conversation pointer. On rehydrate, `dispatches[]` keeps one member per ID: later record fields overlay earlier ones while earlier fields absent from the terminal record remain. Therefore the nested member's `status`, `conversationId`, and `elapsed` always match the top-level rehydrated lifecycle state; a completed dispatch never reappears as a running, transcript-less member after restart.

### Recovering full metadata on demand

A consumer that receives `_truncated` can request `get_agent_state` with its session key. The engine returns `{ agents: [...] }` as the `ServerResult.data` payload for **that requesting socket only**, using the full-fidelity registry snapshot without metadata bounds. It is deliberately a command result rather than an engine event: engine events broadcast to every attached client, and broadcasting a large retrieval response would recreate the repeated fan-out this bound prevents. One explicit local-socket request may carry tens of megabytes; repeated unsolicited snapshots may not.

> **iOS caveat.** iOS rebuilds the metadata map from its typed fields when it persists a tab snapshot, so unknown keys — including `_truncated` — do not survive a save/load round-trip. The marker is reliable on first receipt.

## Emission cardinality: dedup and coalescing

The engine does not emit every internally-observed change as its own frame.

- **Identical repeats are suppressed.** Re-sending a byte-identical snapshot is a no-op by definition under replace semantics.
- **Metadata-only bursts are coalesced** through a leading+trailing rate limiter (default 250 ms, `limits.agentStateEmit.coalesceMs`). The first change in an idle window emits immediately, so an isolated update has no added latency; only a burst collapses, and the trailing flush re-reads current state.

This is safe because snapshot *N+1* is a total function of engine state and strictly supersedes *N*: a consumer receiving only *N+1* lands in exactly the state it would occupy after applying *N* then *N+1*. Combined with rule 3 above — consumers must not derive history from these events — no conforming consumer can observe the difference.

**Two classes never wait:**

- **Forced emissions** — heartbeat and reconcile, where the repeat *is* the signal, plus every terminal transition (abort, run exit, extension death, dispatch rehydrate). These bypass both gates.
- **Structural changes** — any change to the ordered `(name, id, status)` tuple set. An agent appearing, disappearing, or reaching a terminal status flushes synchronously. Only metadata churn is ever held.

Set `coalesceMs: -1` to restore per-change emission cardinality exactly, or `dedup: false` to restore repeats.

## Examples

### A spawner emits a complete snapshot

```typescript
ctx.emit({
  type: 'engine_agent_state',
  agents: [
    { name: 'chief-of-staff', status: 'idle',    metadata: { displayName: 'Chief', visibility: 'always',  invited: true, type: 'chief' } },
    { name: 'cloud-architect', status: 'running', metadata: { displayName: 'Cloud Architect', visibility: 'sticky', invited: true, type: 'specialist', startTime: 1730000000 } },
  ],
})
```

When the specialist finishes:

```typescript
ctx.emit({
  type: 'engine_agent_state',
  agents: [
    { name: 'chief-of-staff', status: 'idle',  metadata: { displayName: 'Chief', visibility: 'always', invited: true, type: 'chief' } },
    { name: 'cloud-architect', status: 'done', metadata: { displayName: 'Cloud Architect', visibility: 'sticky', invited: true, type: 'specialist', elapsed: 47.3, lastWork: 'Drafted Terraform for VPC.' } },
  ],
})
```

The harness includes the chief in every snapshot because it's `visibility: always` and the harness wants it visible. The renderer doesn't need to remember the chief between events — the harness keeps re-emitting it.

### Session reset

When the harness wants to wipe the panel:

```typescript
ctx.emit({ type: 'engine_agent_state', agents: [] })
```

Consumers drop every entry. There is no "soft clear" vs "hard clear" distinction.

## Further reading

- Wire format reference: [Server Events](../protocol/server-events.md#engine_agent_state)
- Run lifecycle that drives the engine's emissions: [Session Lifecycle](../sessions/lifecycle.md)
- Extension emission API: [TypeScript SDK](../extensions/sdk-typescript.md)
- Engine internals: [Engine](engine.md)
- Pass-through hints on other engine events: [Well-known metadata keys for engine_harness_message](../protocol/server-events.md#well-known-metadata-keys-for-engine_harness_message) — the same opaque-metadata pattern applied to harness messages (e.g. `dedupKey` for renderer-side dedup).

## Related contracts

The snapshot-replace contract documented above is the canonical example of a
broader principle: every event's *semantics* (snapshot vs incremental, state
vs workflow, replace vs merge, idempotency) are part of its contract, and
changing them is a breaking change even when the wire shape is unchanged.
The same framing applies elsewhere in the engine:

- **State vs workflow events.** [ADR-003](adr/003-state-events-vs-workflow-events.md)
  splits `engine_plan_mode_changed` (state-only) from `engine_plan_proposal`
  (workflow-only) so consumers don't have to filter the same event by trigger
  origin. The pattern is the same one applied here: pick one semantic role
  per event and document it.

- **Snapshot vs incremental more generally.** `engine_command_registry`
  follows the same snapshot-replace contract as `engine_agent_state`: every
  emission is a complete listing of the session's extension slash commands;
  consumers replace their cached set with the payload; an empty `commands: []`
  is the authoritative "no extension commands" signal, not a no-op. See the
  field comment on [`EngineEvent.Commands`](https://github.com/dsswift/ion/blob/main/engine/internal/types/types.go).

- **Plan-mode lifecycle.** The plan-mode events section in
  [Session Lifecycle](../sessions/lifecycle.md) documents which transitions
  fire `engine_plan_mode_changed` and which proposals fire
  `engine_plan_proposal`.

When designing a new event, decide and document up front: is it a snapshot
or an incremental update? Is it a state transition or a workflow proposal?
Each axis is part of the contract. Future event design should pick one role
per axis and stick to it; the discriminated-event pattern (a `kind` field
on the variant struct) is preferred over conflating multiple roles into one
event type.

## Run recovery journal lifecycle

Run recovery records accepted work before dispatch. A terminal root-run exit
clears the journal for that run identity. A parked root exit (`suspended`) keeps
it because the engine will wake that same work later. This preserves restart
recovery for interrupted work without replaying a run that already finished.
