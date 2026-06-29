---
title: "ADR-014: Dispatch Conversation Identity"
description: Every dispatch mints a fresh conversation by default; continuation is an explicit, dispatch-id-targeted act; the engine is opinionless about conversation relationships.
sidebar_position: 14
---

# ADR-014: Dispatch Conversation Identity

## Status

Accepted

## Date

2026-06-28

## Context

When an orchestrator dispatches an agent, the engine starts a session keyed to a conversation id. The question this ADR answers is: what conversation does that dispatch get, and when (if ever) does a new dispatch continue a prior one?

Before this ADR, the extension resolved dispatch sessions by agent name. Two dispatches of the same agent shared a conversation — the second turn picked up where the first left off automatically. This was called auto-resume-by-name.

Auto-resume-by-name created three concrete problems:

1. **Cross-leaked client rendering.** N dispatches collapsed into one conversation. Events from dispatch 2 threaded into dispatch 1's scrollback. Clients had no clean boundary to slice on; they applied ad-hoc heuristics to separate rendering.
2. **Invisible shared state.** The consumer never opted into conversation sharing. It happened as a side effect of naming. There was no signal on the wire that two dispatches were the same conversation.
3. **Parallel dispatch broke silently.** Two concurrent dispatches of the same agent shared a conversation, so their tool calls, turns, and events interleaved in a single thread. No mechanism existed to tell them apart after the fact or to continue one independently of the other.

## Decision

### (1) Every dispatch is its own isolated conversation by default

The engine mints a fresh conversation id per dispatch. Two dispatches of the same agent are two conversations unless the consumer explicitly requests otherwise.

### (2) Continuation is explicit and dispatch-id-targeted

A follow-up turn into a prior dispatch's conversation is an explicit act. The consumer passes a prior dispatch's id. The extension resolves that id to that dispatch's conversation id and threads it as the engine session key. The engine then continues the existing conversation.

Continuation is never automatic. No implicit "last dispatch" tracking. No name-based resume.

### (3) The engine is opinionless about conversation relationships

The engine maps a session key to a conversation and executes the run. It has no parent/child concept, no lineage graph, no notion that conversation A is a follow-up to conversation B. Relationship semantics belong to the consumer layer.

The existing engine continuation mechanism is unchanged: an empty session key starts a fresh conversation; a known key continues the existing one. This ADR assigns meaning to *what key gets passed in*, not to the engine's key-handling logic.

### (4) Association of dispatches to a tab is consumer-owned

The extension records a dispatch id per dispatch as metadata alongside its tab association. The engine does not record which tab a dispatch belongs to; that mapping is the extension's concern.

### (5) Parallel dispatches of the same agent are first-class

Each parallel dispatch instance has a unique dispatch id and a unique conversation id. The instances are independently recallable and independently continuable. No collision, no disambiguation burden.

## Rationale

### Alternative (a): auto-resume-by-name (the prior behavior) — rejected

Sharing a conversation across dispatches by name is an invisible default. Consumers cannot opt out without knowing the behavior exists. The cross-leaked rendering incident was a direct consequence: the consumer had no way to tell the engine "these are two separate conversations" because the engine never offered that choice. An invisible default that causes client rendering bugs is the wrong default.

### Alternative (b): a `continue: true` flag meaning "continue the last dispatch" — rejected

A flag that means "continue the most recent dispatch of this agent" fails the moment two dispatches of the same agent run in parallel. Which dispatch is "last" becomes undefined; whichever finishes registering first wins, and the consumer has no way to control which. The parallel-dispatch collision is the decisive argument here: any "implicit last" mechanism is incompatible with first-class parallel dispatch, and first-class parallel dispatch is a stated requirement.

### Alternative (c): engine-level `ParentConversationID` lineage — rejected

Adding a parent/child lineage concept to the engine core would push an opinion — that conversations form trees — into the layer that is explicitly opinionless about relationships (per ADR-001 and ADR-012). The extension already owns the association of dispatches to tabs; extending that ownership to include dispatch-to-dispatch relationships requires no new engine mechanism. Lineage is a consumer concern, not an engine concern.

### Why the existing engine mechanism is sufficient

The engine continuation mechanic (empty key = fresh conversation, known key = continue) already does exactly what is needed. This ADR uses it directly: for a new dispatch, pass no prior key (fresh); for a continuation dispatch, pass the prior dispatch's conversation key (continue). No engine change is required for the mechanism. The change is entirely in how the extension assigns keys.

## Consequences

### Positive

- **Clean isolated context per dispatch.** Each dispatch starts with a fresh conversation. No context bleed between dispatches.
- **Parallel dispatch enabled.** Two concurrent dispatches of the same agent are two independent conversations. Events, tool calls, and turns do not interleave.
- **No client-side slicing needed.** The client receives events scoped to one conversation per dispatch. No ad-hoc heuristics to split a shared scrollback.
- **Thin-client correctness.** The conversation boundary on the wire matches the dispatch boundary the consumer thinks in terms of.

### Negative / obligations

- **`DispatchAgentResult` gains a `dispatchId` field.** This is an additive, backward-compatible SDK change. Consumers that want to use continuation must read this field and pass it on follow-up calls. Consumers that do not want continuation ignore it.
- **Historical sessions with shared conversations render as-is.** Sessions created under auto-resume-by-name contain multiple dispatch turns in one conversation. Those sessions are not migrated; they render as a single conversation thread, which is what the engine recorded.
- **Consumers wanting continuation must track dispatch ids.** Previously the engine resumed automatically. Now the consumer owns the decision and must store the dispatch id if it intends to continue a run. This is intentional: the cost of continuation is visibility.

## Related

- [ADR-001](./001-engine-vs-harness.md) — extends. This ADR is a direct application of the engine-vs-harness delegation principle: the engine provides the key-to-conversation mechanism; the harness owns the policy of which key to pass and what that means for orchestration.
- [ADR-009](./009-unified-conversation-model.md) — extends. ADR-009 established one conversation per tab (flat layout). This ADR defines the sub-structure within that model: per-dispatch conversations within a tab's lifetime, each independently continuable.
- [ADR-002](./002-engine-vs-harness-early-stop.md) — parallel. Early-stop continuation is another consumer-owned policy decision using an engine mechanism. The same "engine provides the mechanism, harness owns the policy" split applies here to conversation continuation.
- [ADR-010](./010-bare-session-key.md) — consistent. The session key is opaque to the engine. This ADR assigns meaning to key construction (dispatch id -> conversation key) at the extension layer without the engine parsing or interpreting the key.
- [ADR-012](./012-enterprise-new-tab-defaults.md) — consistent. ADR-012 established the opinionless-mechanics framing: engine owns the sealed-config mechanism, consumers own the policy. This ADR applies the same split to session identity: engine owns key-to-conversation mapping, extension owns the policy of which key represents which dispatch.
- [ADR-013](./013-engine-dead-clean-cancel.md) — teardown semantics unaffected. The clean-cancel and abnormal-termination teardown paths defined in ADR-013 apply identically to isolated dispatch conversations. Each dispatch conversation tears down independently per those rules.
