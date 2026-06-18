# ADR 008 - Wire event naming and ownership

**Status:** Accepted  
**Date:** 2026-06-16

## Context

The Ion engine emits events over two distinct wire layers:

1. **Engine wire** - the NDJSON socket consumed by every client (desktop, iOS, relay, and any external integrator building against the engine protocol).
2. **Desktop↔iOS wire** - a separate WebSocket multiplexing desktop-managed events (tab state, settings, permissions, terminal, git, filesystem, etc.) to the iOS client.

Before this ADR, the desktop↔iOS wire mixed naming conventions: some members carried an `engine_` prefix (borrowed from the engine wire), others were unprefixed. This made ownership ambiguous at a glance - a reader could not determine whether an `engine_status` on the desktop transport was the engine's own event forwarded verbatim or a desktop-managed event wearing a borrowed name.

The engine wire was already uniformly `engine_`-prefixed across its outbound event set - all `EngineEvent` types follow this convention. One event in the `#240` branch, `plan_content`, violated the pattern by emitting a bare name directly on the engine socket; that defect is corrected concurrently with this ADR.

## Decision

### Rule: prefix by contract owner

Wire events are prefixed by the **owner of the contract**.

| Owner | Prefix | Wire |
|-------|--------|------|
| Engine | `engine_` | Engine NDJSON socket |
| Desktop | `desktop_` | Desktop↔iOS WebSocket |
| Android (future) | `android_` | Desktop↔Android WebSocket |
| Web (future) | `web_` | Desktop↔Web WebSocket |

A client that only **consumes** another owner's wire adds no events of its own.

### Engine wire

The engine owns its outbound contract. The engine's outbound event set is uniformly `engine_`-prefixed (see `engine/internal/types/engine_event.go` for the authoritative list). This is the precedent the standard codifies - no refactor of existing engine events is needed or wanted.

**Architectural note on internal vs. wire names.** `NormalizedEvent` (`engine/internal/types/normalized_event.go`) uses bare names internally (`text_chunk`, `status`, etc.). These names never reach a consumer: `translateToEngineEvent()` converts them to `engine_*` `EngineEvent` values before anything is written to the socket. The bare internal names and the wire names are distinct layers; there is no inconsistency at the wire boundary.

### Desktop↔iOS wire

The desktop owns 100% of the desktop↔iOS wire. iOS declares its models as mirrors of `RemoteCommand` and `RemoteEvent` from `desktop/src/main/remote/protocol.ts`; iOS introduces no wire events of its own. All members of `RemoteEvent` and `RemoteCommand` carry the `desktop_` prefix.

`desktop_settings_snapshot` already followed this convention before this ADR - it is proof the `desktop_` prefix was the intended standard, just inconsistently applied elsewhere.

### Future clients

When a new client type owns a wire (Android, web, etc.), it follows the same rule with its own prefix (`android_`, `web_`). If the client only mirrors an existing owner's wire, it adds no events of its own.

## Rationale

**Ownership legible from the string alone.** Any developer reading a wire capture, a log file, or a code path can immediately determine which layer owns the event without looking up a cross-reference table. `engine_text_delta` is the engine's event. `desktop_text_delta` is the desktop's transport packaging of a text delta for iOS. Two names, two layers, no ambiguity.

**Disjoint namespaces prevent collisions.** After the rename, every engine wire string begins `engine_` and every desktop wire string begins `desktop_`. The two sets are disjoint by construction. Future client prefixes extend this invariant. Collision detection can be automated (collision gate: assert no member of the desktop set begins `engine_`, and vice versa).

**Codifies existing practice.** The engine wire was already 100% `engine_`-prefixed. This ADR names the pattern, explains why it exists, and extends it to the desktop layer rather than introducing a new convention from scratch.

## Contract stability policy

The two wires carry different stability obligations.

### Engine wire - scrutinized contract

The engine wire is a **scrutinized contract**. External integrators build against the engine socket directly; Ion cannot reach them to coordinate a migration. A breaking change to the engine wire (removing or renaming an event type or field) must be a conscious, surfaced decision - never committed silently.

Correcting an improper legacy name **may** be committed as a breaking change in a future version using `fix` (not `feat!`) unless the rename is genuinely application-sweeping. The `plan_content` → `engine_plan_content` conformance fix accompanying this ADR is one such correction; it applies to a name that was never shipped in a released version, so no existing external consumer is affected.

### Desktop↔iOS wire and future client wires - lockstep, not scrutinized

Desktop↔iOS and all future client wires operate under a **lockstep model**: every change ships to all clients in one PR. There is no deployment window where the desktop ships with the new string and iOS still expects the old one. A wire rename on this layer is not a breaking change in the external-integrator sense - it is a coordinated update across code that moves together.

The agent's **only obligation** for a desktop↔iOS wire change is **parity**: mirror both (or all) sides of the rename in the same PR. Breaking-change avoidance rules that apply to the engine wire do not apply here. Agents must not push back on desktop↔iOS or future-client wire changes as though they were published-contract breaks.

## Consequences

- Agents reviewing or implementing desktop↔iOS wire changes stop treating them as published-contract breaks. The parity check (all clients updated in the same PR) is the only required gate.
- Any new `RemoteEvent` or `RemoteCommand` member introduced to the desktop↔iOS wire must carry the `desktop_` prefix from its first commit. PRs that introduce unprefixed or `engine_`-prefixed members on this wire are non-conforming.
- Any new engine wire event must carry the `engine_` prefix. The engine contract test (`engine/internal/types/contract_test.go`) and the Go golden manifest (`engine/internal/types/testdata/contracts.json`) remain the authoritative enforcement mechanism.
- Future client wires (Android, web, etc.) must establish their owner prefix in their first PR and maintain it uniformly.
- Do not hard-encode event counts in prose or documentation. Describe the event set qualitatively and link to the authoritative source file.
