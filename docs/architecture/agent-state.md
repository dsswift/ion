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
| `lastWork` | string | Short summary of the agent's last activity (truncated, ≤100 chars). |
| `fullOutput` | string | Full agent output (clients may render or hide). |
| `elapsed` | number | Wall-clock seconds since `startTime`. |
| `startTime` | number | Unix timestamp (seconds) when the agent started its current run. |
| `cost` | number | Cumulative USD cost for this agent's runs in this session. |
| `conversationId` | string | Backend session id for "rewind into this agent's transcript" features. |
| `parentAgent` | string | Name of the dispatching agent (for tree views). |
| `depth` | number | Nesting depth from the root run. |

The list is advisory. Extensions are free to add their own keys; pick a unique prefix to avoid collisions.

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
