---
title: "ADR-028: Interrupted Run Recovery"
description: Durable recovery journal lets consumers resume interrupted work without replaying user input.
---

# ADR-028: Interrupted Run Recovery

## Status

Accepted.

## Context

An engine process can terminate during a root conversation run because of an upgrade, restart, crash, or host failure. Conversation history can survive, while live run identity, queued work, provider streams, and tool execution cannot. Reattaching a session to its conversation therefore reports idle unless the engine records that work was interrupted.

A client-side guess from a previous tab status or last visible prompt is unsafe. It cannot distinguish a completed run from an interrupted one after client restart, and replaying a user prompt can duplicate the user turn or retry an external side effect without evidence that it did not occur.

## Decision

The engine owns recovery mechanics.

- Before dispatching an accepted recoverable run, the engine writes an active-run journal into the conversation's atomic persistence record.
- The journal stores the recovery identity, original dispatch options, canonical persisted user-entry identity, durable checkpoint, and recovery attempts.
- On a new engine session, recovery policy resolves in this order: built-in off, merged `engine.json` `runRecovery` default, `start_session` `EngineConfig.runRecovery`, then an extension's session-local override.
- An active journal is consumed only when resolved policy enables recovery. The engine increments its attempt count durably before beginning recovery.
- Recovery continues from the durable conversation checkpoint. It does not append the original user prompt again. Completed entries remain intact; uncertain tool effects are represented as interrupted/unknown and the recovered run receives a machine-authored instruction to inspect state before retrying work.
- Explicit abort, explicit stop, normal completion, and terminal failure clear the journal. Process-restart teardown preserves it.
- Engine emits typed recovery lifecycle events. Clients decide whether and how to render failure, skip, or exhausted outcomes. Successful recovery is not a UI event requiring a client policy.
- Extensions can set session-local recovery policy with `ext/set_run_recovery`. `enabled` is required, and the policy applies to later runs only. It overrides `start_session` and `engine.json` policy but cannot rewrite an active journal.
- Extensions receive `before_run_recovery` after durable attempt increment. They can skip recovery or replace the generic continuation instruction. Empty fields leave engine policy unchanged.

## Consequences

An engine with no `runRecovery` configuration preserves existing behavior. A headless client may opt in per session. An operator may set a default for all sessions in `engine.json`. A client may explicitly opt a session in or out. An extension can make the final session-local decision.

Recovery is exact about durable history and conservative about unknown effects. It does not promise exactly-once execution for work interrupted while an external tool or provider call was in flight. Instead, it preserves the fact that the outcome is unknown and directs the resumed run to inspect state before acting.

Desktop ships its existing `tabRecoveryEnabled` preference enabled. Its broadened **Automatic Conversation Recovery** setting explicitly enables recovery for normal desktop conversations and also retains stuck-tab recovery. Extension-profile sessions receive no forced desktop preference, so engine and extension policy govern them.
