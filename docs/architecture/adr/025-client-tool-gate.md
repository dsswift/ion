---
title: "ADR-025: Client Tool Gate"
description: A session's owning client can refuse tool calls and provide its own tools over the wire; the engine owns the blocking mechanism and no policy.
---

# ADR-025: Client Tool Gate

## Status

Accepted.

## Context

The engine's tool loop had three decision surfaces before a tool executed: the
permission engine (policy files), workspace containment (the deterministic
worktree safety baseline), and the extension `tool_call` hook (subprocess
extensions). A **wire-protocol client** — the desktop, a custom harness, a
headless pipeline — had no seam of its own: it could not refuse a tool call,
and it could not provide a tool without writing an extension or an MCP server.

The forcing case was the integration bench (ADR-024). Its agent-facing rules —
refuse history writes and file edits in a disposable tree, carve out the
resolve-once merge flow, answer attribution questions — were enforced in
engine core alongside worktree containment. That placement conflated two
different obligations. Worktree isolation is a universal safety invariant:
every consumer running parallel scoped agents needs it, it derives from two
paths and git state, and it must hold regardless of what else is loaded — it
belongs in engine core. The bench is one product's workflow: a consumer
without Ion's desktop never has a bench, and baking its vocabulary, schema,
and three purpose-built tools into engine core forced every consumer to carry
one client's opinions (see the root `AGENTS.md` § "Opinionless mechanics,
extensible opinions").

Moving the bench rules to the desktop required a capability the wire did not
have: a way for the session's owning client to answer "may this tool call
proceed?" and "here is the result of my tool" *during* the tool loop.

## Decision

### One request/response pair, two kinds

A session opts in at `start_session` via `EngineConfig.toolGate`. For a gated
call the engine emits `engine_tool_gate_request` and blocks that call's
goroutine until a `tool_gate_response` arrives or the declared timeout applies
the declared fallback. `gateKind` selects the exchange:

- **`policy`** — may this call proceed? The client answers `allow`/`deny` with
  a model-facing reason. The request carries the tool name, input, cwd, and
  `gateSiblingTools` (the other calls in the same model turn, which run
  concurrently) so turn-isolation policies are evaluable.
- **`tool`** — the model called one of the client's declared
  `toolGate.clientTools`; the client executes it and answers with
  `gateContent`/`gateIsError`. Client tools join the session's tool list
  beside MCP and extension tools — the third tool provision path.

### The engine owns the mechanism and no policy

The engine suspends the call, transports the question, bounds the wait, and
applies the client's own declared fallback (`timeoutDecision`, default
`allow`) when no answer arrives. It never decides allow/deny itself. No
opt-in means no round-trip: every consumer that does not declare a gate sees
zero behavior change, which is what keeps the hot path free for headless
pipelines.

### Ordering in the tool loop

Permission engine → workspace containment → **client gate** → sandbox wrap →
extension `tool_call` hook → execution. A call the engine's own checks refuse
never pays the client round-trip; a call the session owner denies never
reaches extension processing or the sandbox. A gate deny produces the same
tool-result shape as a permission deny and fires the same `permission_denied`
observability path, with its own telemetry category (`client_gate_denied`).

### Not the human permission queue

`engine_tool_gate_request` is deliberately a separate event from
`engine_permission_request`. That event is a human ask — clients surface it in
approval UI and iOS promotes it into the permission queue. The gate is
answered by client *code*. Sharing the event would put machine-policy
questions in front of humans and stall tool calls on human latency.

### Failure modes are declared, never guessed

The wait is bounded by the client's `timeoutMs` (default 2000ms; client tools
`clientToolTimeoutMs`, default 30000ms). On timeout the engine applies the
declared fallback and logs it; an unrecognized decision resolves to allow (an
unparseable reply must not invent a refusal); a late reply is logged and
dropped by the pending broker; an unfulfilled client tool is a tool error the
model reads, never a hang.

## Consequences

- The bench's agent-facing surface lives in the desktop
  (`tool-gate-responder.ts`, `bench-tool-policy.ts`, the three bench client
  tools), beside the bench lifecycle it belongs to. ADR-024's enforcement
  table reflects this.
- The engine's `internal/workspaces` retains only the generic worktree
  mechanism, and `security.workspaceContainment` is scoped to worktrees.
- Any wire consumer can now enforce fleet policy (compliance gates, dry-run
  modes, path freezes) and provide local tools without an extension host.
- A gating client accepts the latency of its own gate on gated calls, and a
  deny-on-timeout client accepts that its own unavailability stops tool
  execution. Both are the client's declared choice.

## References

- ADR-001 (engine vs harness), ADR-006 (deterministic seams), ADR-024 (the
  bench).
- Protocol: `docs/protocol/client-commands.md` § `tool_gate_response`,
  `docs/protocol/server-events.md` § `engine_tool_gate_request`.
- Engine: `engine/internal/types/tool_gate.go`,
  `engine/internal/session/tool_gate.go`,
  `engine/internal/backend/runloop_tool_gate.go`.
- Desktop: `desktop/src/main/tool-gate-responder.ts`.
