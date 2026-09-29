---
title: Contract Stability
description: Stability rules for the engine wire, the Studio wire, wire naming, and cross-language type sync.
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
| NormalizedEvent variants & fields | `engine/internal/types/normalized_event.go`, mirrored in `packages/shared/src/types-events.ts` and `ios/IonRemote/Models/NormalizedEvent.swift` |
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

## The Studio wire's client surface - lockstep, not scrutinized

There is one client wire: the [Studio wire](../protocol/studio-wire.md). Studio, a browser, and iOS all speak it to a server. The separate `desktop_*` device transport the phone used to speak is gone — see [ADR-035](adr/035-one-wire.md).

The wire's client surface operates under a **lockstep model**. Every client that speaks it is co-located in this repo, so a rename ships to every side in one PR and there is no deployment window where one side has the new string and the other has the old one. These changes are not breaking changes in the external-integrator sense.

**Do not push back on a Studio-wire client-surface change as though it were a published-contract break.** It is not. The only obligation is **parity**: every side is updated in the same PR.

Parity check for a client-surface change: confirm `packages/shared/src/studio-wire/` (frame types, `EVENT_CHANNELS`, the action table), the thin payload types in `server/src/remote/protocol.ts`, the iOS `RemoteCommand.swift` / `NormalizedEvent.swift` TypeKey raw values and `StudioTransportCommandMapping.swift`, and any ViewModel or handler that switches on the string are all updated in the same commit (or PR). A new phone command must also have a row in `packages/shared/src/studio-wire/phone-command-map.json`, which a test on each side reads from disk.

**The engine wire is still scrutinized.** Nothing above relaxes the rules in the previous section.

## Wire event naming - prefix by owner (ADR 008)

Wire events are prefixed by the **owner of the contract**. See [docs/architecture/adr/008-wire-event-naming-and-ownership.md](adr/008-wire-event-naming-and-ownership.md) for the full rationale.

| Owner | Prefix | Wire |
|-------|--------|------|
| Engine | `engine_` | Engine NDJSON socket |
| Server | `desktop_` | The Studio wire's thin payloads |
| Studio SDK | `ion-studio.` | Studio control resources |

The engine's outbound event set is uniformly `engine_`-prefixed (see `engine/internal/types/engine_event.go`).

The `desktop_` prefix now names **server-derived payloads on the Studio wire**, not a wire of its own. A thin client receives them on `studio:thin-event`: the server does the derivation once (transcript rows out of engine tool events, batched text deltas, tab and worktree state) and every thin client renders the result rather than re-implementing it against raw engine events. The prefix is historical — it was the `desktop_*` device transport's — and it is kept because renaming a payload type that three clients decode buys nothing. Any new member carries the correct prefix from its first commit; PRs that introduce unprefixed or cross-prefixed members are non-conforming.

**Internal vs. wire names.** `NormalizedEvent` uses bare names internally. These never reach a consumer: `translateToEngineEvent()` converts them to `engine_*` before anything is written to the socket. The bare internal names and the wire names are distinct layers.

## Cross-language contract sync

Go is the source of truth. A reflection-based test (`engine/internal/types/contract_test.go`) extracts every shared struct's JSON field names into a golden manifest (`engine/internal/types/testdata/contracts.json`). TS and Swift tests validate against it.

**Workflow when you change a shared type (NormalizedEvent variant, StatusFields, EngineConfig, etc.):**

1. Make the Go change in `engine/internal/types/`.
2. Regenerate the manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`
3. Update the TS field map in `packages/shared/src/__tests__/contract-sync.test.ts` to match.
4. Update the TS type definition in the appropriate file under `packages/shared/src/`: `types-engine.ts`, `types-events.ts`, or `types-engine-event.ts` (the `EngineEvent` discriminated union lives in `types-engine-event.ts`, split from `types-engine.ts` to stay under the 600-line cap).
5. Update the Swift type in `ios/IonRemote/Models/` and the Swift contract test if field coverage changed.
6. Run `make check-contracts`, `npm test`, and `make ios-check` to verify.

If you skip a step, CI fails with a clear message identifying the drift (e.g. `"Go-only: [newField]"`).
