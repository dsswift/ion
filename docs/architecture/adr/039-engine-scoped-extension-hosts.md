---
title: "ADR-039: Engine-Scoped Extension Hosts"
description: An extension may run one host owned by the engine process. Its schedules and webhooks fire into headless sessions the engine mints per fire under a configured run-as principal, so scheduled work no longer needs an open conversation.
---

# ADR-039: Engine-Scoped Extension Hosts

## Status

Accepted.

## Context

An extension host was a per-conversation process. The engine spawned it when a session started, bound it to that session key, and stopped it with the session. Every schedule and webhook the host registered fired into that conversation through the async resolver, and a session holding such a registration was never idle-released.

That bound scheduled work to a conversation a person had to keep open. A harness that wanted a daily briefing, an inbox triage, or a repository sync kept a conversation resident for it, which only a client could do; a headless deployment had no such client. One harness worked around the gap by shelling out to `ion prompt` from inside a schedule handler, running a second engine to get a session the first could not give it.

A second gap was identity. The engine process has one Context Identity, but a session carries its own principal, supplied by the client at `start_session`, and partitioning, tool policy, telemetry attribution, and git author all key on it. Work that ran with nobody at the controls either borrowed whichever principal happened to be connected, or ran with none.

## Decision

**An extension declares its scope.** `extension.json` gains `scope`: `session` (the default, one host per conversation, unchanged), `engine` (one host for the engine process, no session hosts), or `both`. The engine spawns engine hosts at boot from the `extensionHosts` block of `engine.json` and stops them at shutdown.

**Each half registers what belongs to it.** Hooks, tools, and commands belong to session hosts; an engine host's are dropped at init and logged. Schedules and webhooks declared at init belong to the engine host when one exists; a session host of an `engine` or `both` extension has those refused with `scope_mismatch`, while a job it registers at runtime from a hook stays bound to its conversation as before. Resource producers may live on either. The process learns its half from `ION_EXTENSION_SCOPE` before init and from `scope` in the init config, so registrations made before the handshake can branch.

**A fire gets its own session.** The async resolver, asked for an engine host's context, mints a headless session: a real session with a fresh conversation on disk, the session-scoped extensions loaded, hooks and tools working, keyed `headless:<extension>:<nanos>`, reported by `list_sessions` with `headless: true`, subscribed to by no client. The fire envelope carries that session's key. Idle release stops it after the short headless window once its work, including any detached dispatch, is done, and does not ask `session_before_release`, because no harness owns it.

**Headless sessions act as a configured principal.** `extensionHosts.runAs` is either a literal principal (a single-tenant deployment names its one operator) or the engine's own verified workload identity (`kind: workload`, subject from the provider or `workload:<provider>:<clientId>`). Unset means unattributed, logged. A headless session never borrows a connected person's principal. The engine host receives `identity_changed` with `Reason: "run_as"` so a harness that keeps a principal from that hook needs no new code.

## Consequences

- Scheduled and webhook-driven work runs with zero conversations open, on a desktop or in a container, and the harness that shelled out to `ion prompt` for a session stops doing so.
- A headless session is a full session: it costs a conversation file, an extension process per session-scoped extension, and the fire's model usage, attributed to the run-as principal. The headless idle window keeps that short.
- A `session`-scoped extension is byte-identical to before: no manifest change, no behavior change, schedules still bind to the conversation.
- The engine wire gains additive fields only: `SessionInfo.headless`, `ExtensionConfig.scope`, `SessionPrincipal.kind` value `workload`, and the `run_as` reason on `identity_changed`.

## Rejected

- **One long-lived worker session per extension.** State would leak between jobs, one stuck job would block the rest, and `concurrency: all` would have nowhere to run. A session per fire reuses the dispatch-child shape the engine already had.
- **Borrowing a connected session's principal for headless work.** That is the bug this ADR removes: an action nobody chose, attributed to whoever was logged in.
- **Letting the harness fake it.** A timer plus `ion prompt` is a second engine standing in for a missing primitive; the grounding rules name that as the thing never to do.
