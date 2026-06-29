---
title: "ADR-009: Unified Conversation Model and Flat Single-Tab Layout"
description: One conversation type, one creation entry point, flat per-tab layout. The extension list (possibly empty) is the only variable.
sidebar_position: 9
---

# ADR-009: Unified Conversation Model and Flat Single-Tab Layout

## Status

Accepted

## Date

2026-06-19

## Context

Ion conversations had two distinct client-side identities: a "plain
conversation" (no engine extension, driven by the normalized event
stream) and an "extension-hosted conversation" (an engine extension
loaded, driven by the raw `engine_*` stream). Clients stored a
`hasEngineExtension` boolean in runtime tab state as a discriminator
and exposed two separate creation entry points: one for plain
conversations and one for extension-hosted conversations.

Alongside this, extension-hosted tabs used in-tab multiplexing: a
single top-level tab could host N conversation instances, each with
its own scrollback, session, and status. The instance array was
reflected to iOS via `conversationInstances` in the snapshot.

The engine itself never had this split. The engine treats every session
identically: it starts a session, loads whatever extensions were
specified, and runs the agent loop. The plain-vs-hosted distinction was
a client-only concept imposed on top of an already-unified engine.

The two-type model created friction at every layer:

- Two creation code paths with overlapping but divergent logic.
- `hasEngineExtension` had to be threaded through state, persistence,
  and snapshot projection, even though the engine never consulted it.
- Multi-instance layout required the client to maintain an active
  instance pointer, fan events to the right instance, and serialize the
  instance array to disk -- complexity the feature did not justify.
- The needs multi-instance tabs served (identify which harness runs on
  a tab, group same-harness tabs together) were already addressable by
  existing features: a per-tab harness badge derived from `engineProfileId`
  and the tab-groups feature.

## Decision

### One conversation type

There is exactly one conversation type. Every conversation is created
through one entry point ("New Conversation") and one code path
(`createConversationTab`). The extension list is the only variable: if
the user selects an engine profile, that profile's extensions are loaded;
if no profile is selected, the conversation runs with no extensions. An
empty extension list and a populated one are the same conversation type
with different configuration.

### Derived, not stored

`hasEngineExtension` is removed from runtime `TabState`. Whether a
conversation has extensions is derived at read time via `tabHasExtensions()`:
a non-null, non-empty `engineProfileId` on the tab means extensions are
active. `hasEngineExtension` is still written to the snapshot wire
(derived at the write-site in `snapshot.ts`) because it remains a **live**
field that current iOS clients read off the snapshot to gate extension-only
UI (harness badge visibility, instance routing). It is *derived not stored*
on the desktop — computed at the write-site rather than held in runtime
state — but it is a current wire-contract member, not a deprecated
backward-compat shim.

### Flat single-tab layout

Each conversation is its own top-level tab. In-tab multiplexing is
removed for conversations. A parent tab no longer hosts N conversation
instances. Every instance that previously lived inside an extension-hosted
tab becomes its own standalone tab after migration (see ADR-011).

Terminals retain multi-instance layout because their instance identity is
variable (a terminal spawns instances dynamically and each has a transient
id). Conversations do not need this: each conversation has exactly one
session, and the top-level tab is a sufficient container.

## Rationale

**The engine was already unified.** Aligning the clients to the engine's
actual model removes a client-only abstraction that had no engine
counterpart. The split existed because clients were built before the
engine's generality was fully leveraged -- not because the engine
required it.

**The needs of multi-instance are met without it.** A per-tab harness
badge (derived from `engineProfileId`) tells users which profile a tab
runs. Tab groups collect same-profile tabs. These cover the two primary
use cases for multi-instance tabs while keeping the data model simple.

**One code path is easier to reason about.** Two creation paths diverged
silently over time. Bugs fixed on one path were not always applied to
the other. A single path eliminates that class of divergence.

**`hasEngineExtension` as a derived value is more reliable.** A stored
boolean can go stale if the profile changes. A value derived from
`engineProfileId` at read time is always consistent with the current
state of the tab.

### Tradeoff considered

A hybrid opt-in model was considered: keep multi-instance for extension
profiles that explicitly request it, go flat for profiles that do not.
This was rejected because the complexity cost of maintaining two layout
modes is the same as the full multi-instance cost -- the code path, the
persistence format, and the snapshot projection all remain dual. The
simpler outcome is to commit fully to flat and use tab groups for the
grouping use case.

## Consequences

- `TabState.hasEngineExtension` is removed from runtime state. All callers
  that previously read the stored boolean are updated to call
  `tabHasExtensions(tab)` instead.
- `createConversationTab` is the single creation entry point for all
  conversations. The previous separate paths are removed.
- The snapshot write-site derives `hasEngineExtension` from `tabHasExtensions`
  before writing to the wire. iOS reads it off the snapshot as a current,
  live field (extension-gated UI); it is derived-not-stored on the desktop
  but is a live wire-contract member, not a deprecated compat field.
- Each extension-hosted tab with N instances is split into N standalone
  tabs on migration (see ADR-011).
- Tab groups replace multi-instance grouping as the recommended pattern
  for organizing same-profile conversations.
