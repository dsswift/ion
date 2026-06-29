---
title: "ADR-010: Bare Session Key for Conversations"
description: The session key for conversations is the bare tabId. The compound tabId:instanceId key is retired for conversations; terminals retain it.
sidebar_position: 10
---

# ADR-010: Bare Session Key for Conversations

## Status

Accepted

## Date

2026-06-19

## Context

When extension-hosted tabs hosted N conversation instances, the desktop
keyed engine sessions with a compound key: `${tabId}:${instanceId}`.
This allowed the engine's event fan-out and the desktop's store to
route events to the correct instance within a tab.

After ADR-009 (flat single-tab layout), every conversation is its own
top-level tab with exactly one instance. The compound key becomes a
degenerate case: every conversation session has a compound key of the
form `${tabId}:main`, where `main` is the constant instance id.

Retaining the compound key in this degenerate form adds cost without
benefit: every event dispatch, store lookup, and snapshot projection
must parse or construct a compound string even though the instance
segment is always the same.

## Decision

The session key for conversations is the **bare `tabId`**. The
`${tabId}:instanceId` compound form is retired for conversations.

Terminals retain the compound key because terminal instances are
dynamically created (each has a distinct, non-constant id) and the
engine needs a stable key per terminal instance.

The engine treats the session key as an opaque string. It does not parse
or interpret the key format. Changing the key format for new sessions
is therefore not an engine-contract change -- no engine code changes.
The desktop and iOS collapsed the key in lockstep (see ADR-008 for the
lockstep-wire framing that governs co-located client changes).

## Rationale

**The compound key served multi-instance routing.** With one instance per
conversation tab, that routing problem does not exist. The compound key
becomes ceremony with no function.

**The engine is key-format agnostic.** The engine stores and routes by
key but does not parse the key's structure. Changing the key format is
entirely a client-side decision. No engine contract is affected, so no
external integrator building against the engine wire is impacted.

**Bare tabId is the stable, natural identity.** The tabId is already the
primary identifier for a conversation in the desktop store, the snapshot,
and iOS view models. Aligning the session key with the tab's own id
removes the translation step that previously converted between the two.

**Lockstep update.** Desktop and iOS are co-located in this repo. Both
sides updated their key construction and parsing in the same PR. There
is no deployment window where the desktop uses a bare key and iOS
expects a compound key. Per ADR-008, this class of change is a
coordinated update, not a breaking change.

## Consequences

- New conversation sessions are started with `tabId` as the session key.
  The previous `${tabId}:main` compound form is no longer produced.
- The store, event handlers, and snapshot projection are updated to use
  the bare `tabId` as the lookup key for conversation sessions.
- Terminal sessions continue to use the compound `${tabId}:${instanceId}`
  form. No change to terminal session keying.
- The engine is not modified. The session key change is entirely within
  the desktop and iOS clients.
- Restored legacy tabs that carried a compound key are handled by the
  migration path (ADR-011).
