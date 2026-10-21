---
title: Contract Stability
description: Stability rules for the engine wire, a client's own wire, wire naming, and cross-language type sync.
sidebar_position: 10
---

# Contract Stability

Not all wire contracts carry the same stability obligation. The rules differ by owner.

## Engine wire - scrutinized contract

The engine wire is a **scrutinized contract**. External integrators build custom clients, shell scripts, and automation pipelines directly against the engine NDJSON socket. Ion cannot reach those consumers to coordinate a migration. A breaking change to the engine wire must be a conscious, surfaced decision — never committed silently.

**Never ship a breaking change to the engine wire contract without explicit operator approval.**

Event-shape contracts are not just about field names. Event **semantics** (snapshot vs. incremental, replace vs. merge, idempotency) are also part of the engine contract. See [docs/architecture/agent-state.md](agent-state.md) for the canonical example: `engine_agent_state` is always a complete snapshot, and consumers replace local state with the payload.

Correcting an improper legacy name on the engine wire **may** be committed as a breaking change in a future version using `fix` (not `feat!`) unless the rename is genuinely application-sweeping. The operator decides; the agent surfaces the decision, never makes it alone.

### What counts as an engine contract

| Surface | Key files |
|---------|-----------|
| Wire protocol | `engine/internal/protocol/protocol.go` (`ClientCommand`, `ServerMessage`, NDJSON shape) |
| NormalizedEvent variants & fields | `engine/internal/types/normalized_event.go`, mirrored by every client that decodes events |
| SDK types & hook signatures | `engine/internal/extension/sdk_types.go`, `sdk_hook_types.go` (`HookHandler`, `Context`, payload types) |
| Hook names & payload shapes | All hooks registered in `engine/internal/extension/sdk_hooks_*.go` |
| Engine events consumed by clients | Any event type or field a client reads to render UI |

### Allowed (non-breaking engine changes)

- **Add** new fields with zero-value defaults, new event variants, new hooks, new optional parameters.
- **Fix** bugs in existing methods (behavior change that corrects a documented or obvious defect).
- **Version** a new alternative when a design must evolve (e.g. `ToolCallV2`) — leave the original intact.

### Forbidden (breaking engine changes)

- Remove or rename a field, type, constant, hook name, or event variant.
- Change a field's type (e.g. `string` → `int`, `[]T` → `map`).
- Alter a hook's payload shape in a non-additive way.
- Remove or reorder positional arguments in an SDK callback signature.
- Change wire-protocol message framing or envelope structure.

If you believe a break is truly necessary, stop and discuss with the user — never commit it silently.

## A client's own wire - lockstep, not scrutinized

A client that fronts the engine for other clients defines its own wire; the archived Ion Studio did ([ADR-035](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/035-one-wire.md)). That wire is the client's contract, not the engine's.

The wire's client surface operates under a **lockstep model**. Every client that speaks it is co-located in the client's repo, so a rename ships to every side in one PR and there is no deployment window where one side has the new string and the other has the old one. These changes are not breaking changes in the external-integrator sense.

**Do not push back on a client-wire change as though it were a published-contract break.** It is not. The only obligation is **parity**: every side is updated in the same PR.

A client that mirrors engine types validates its mirror against the published `engine/internal/types/testdata/contracts.json`; that test is the client's, and it fails when the engine's manifest moves without the mirror.

**The engine wire is still scrutinized.** Nothing above relaxes the rules in the previous section.

## Wire event naming - prefix by owner (ADR 008)

Wire events are prefixed by the **owner of the contract**. See [docs/architecture/adr/008-wire-event-naming-and-ownership.md](adr/008-wire-event-naming-and-ownership.md) for the full rationale.

| Owner | Prefix | Wire |
|-------|--------|------|
| Engine | `engine_` | Engine NDJSON socket |
| A client that fronts the engine | its own prefix (the archived Ion Studio used `desktop_` and `ion-studio.`) | The client's own wire |

The engine's outbound event set is uniformly `engine_`-prefixed (see `engine/internal/types/engine_event.go`).

**Internal vs. wire names.** `NormalizedEvent` uses bare names internally. These never reach a consumer: `translateToEngineEvent()` converts them to `engine_*` before anything is written to the socket. The bare internal names and the wire names are distinct layers.

## Cross-language contract sync

Go is the source of truth. A reflection-based test (`engine/internal/types/contract_test.go`) extracts every shared struct's JSON field names into a golden manifest (`engine/internal/types/testdata/contracts.json`). Client mirrors validate against it.

**Workflow when you change a shared type (NormalizedEvent variant, StatusFields, EngineConfig, etc.):**

1. Make the Go change in `engine/internal/types/`.
2. Regenerate the manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`
3. Update the TypeScript SDK types in `engine/extensions/sdk/ion-sdk/` when the type is part of the SDK surface.
4. Run `make check-contracts` to verify.

If you skip a step, CI fails with a clear message identifying the drift (e.g. `"Go-only: [newField]"`).
