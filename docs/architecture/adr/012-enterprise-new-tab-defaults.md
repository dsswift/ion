---
title: "ADR-012: Enterprise New-Tab Defaults Policy"
description: A sealed EnterpriseConfig.newConversationDefaults policy (baseDirectory, engineProfileId, locked) delivered via get_enterprise_policy RPC and projected to clients via desktop_settings_snapshot. Follows opinionless-mechanics: engine owns the sealed-config mechanism; the new-conversation default is a consumer opinion.
sidebar_position: 12
---

# ADR-012: Enterprise New-Tab Defaults Policy

## Status

Accepted

## Date

2026-06-19

## Revision

The contract originally shipped with the admin config key `newTabDefaults`,
the Go type `NewTabDefaultsPolicy`, the `get_enterprise_policy` RPC result key
`newTabDefaults`, and the `desktop_settings_snapshot` field `newTabPolicy`.
Before external publication these were renamed to keep the engine contract
surface UI-agnostic ("tab" is a client construct; the engine concept is a new
*conversation*):

| Originally | Renamed to |
|------------|------------|
| `EnterpriseConfig.newTabDefaults` (admin key + RPC key) | `newConversationDefaults` |
| `NewTabDefaultsPolicy` (Go / TS type) | `NewConversationDefaultsPolicy` |
| `desktop_settings_snapshot.newTabPolicy` | `newConversationPolicy` |

The rename is reflected throughout this ADR. Administrators authoring managed
config must use the `newConversationDefaults` key; the old `newTabDefaults` key
is not aliased.

## Context

Administrators deploying Ion in managed environments need to set
organization-wide defaults for new conversations: a standard working
directory (e.g. a corporate projects root) and a standard engine profile
(e.g. a profile that loads compliance extensions). In some deployments,
these defaults must be enforced -- users should not be able to start a
conversation in an arbitrary directory or with an arbitrary profile.

Before this ADR, the desktop exposed user-level preferences for a
default base directory and a default engine profile id. There was no
mechanism for an administrator to set or lock these values across a
fleet.

The existing enterprise config layer (MDM/Group Policy, delivered at
the sealed top of the four-layer config merge) already handles
analogous enforcement for model allowlists, tool restrictions, and
permission mode. The new-conversation defaults fit naturally into the same
mechanism.

## Decision

### Config field: `EnterpriseConfig.newConversationDefaults`

A new optional field `newConversationDefaults` is added to `EnterpriseConfig`
(Go: `engine/internal/types/config.go`):

```go
type NewConversationDefaultsPolicy struct {
    BaseDirectory   string `json:"baseDirectory,omitempty"`
    EngineProfileId string `json:"engineProfileId,omitempty"`
    Locked          bool   `json:"locked,omitempty"`
}
```

- `baseDirectory`: the working directory to use for new conversations.
  Empty string means no constraint.
- `engineProfileId`: the engine profile to load. Empty string means
  plain conversation (no extensions).
- `locked`: when `true`, the policy takes runtime precedence. Every
  new-conversation entry point opens with the mandated values,
  regardless of the user's own default-directory and default-profile
  settings. The settings controls remain visible and editable but have
  no effect on new-conversation creation while the lock is active.

### Sealing behavior

`newConversationDefaults` is an override field in the enterprise config merge:
a non-null overlay pointer replaces the base value entirely. A null
overlay preserves the base value. This follows the same pattern as
`network` and `telemetry` in the existing enterprise config.

### Engine RPC: `get_enterprise_policy`

A new engine RPC `get_enterprise_policy` returns the `newConversationDefaults`
section of the loaded enterprise config. Clients call this RPC at
startup rather than parsing MDM sources themselves. The response is:

```json
{ "newConversationDefaults": { ... } }
```

When no enterprise config is loaded, or when the config has no
`newConversationDefaults` section, the response carries `"newConversationDefaults": null`.

### Projection to iOS via `desktop_settings_snapshot`

Desktop fetches the policy from the engine via `get_enterprise_policy`
and includes it as `newConversationPolicy` in the `desktop_settings_snapshot`
event. iOS reads `newConversationPolicy` from the snapshot and applies the same
routing logic as desktop when opening a new conversation.

### Client routing logic

Both clients implement the same decision tree for new-conversation
actions (highest precedence first):

0. **Enterprise-locked**: if `newConversationDefaults.locked` is `true`, open
   directly with the mandated `baseDirectory` and `engineProfileId`.
   Skip all pickers.
1. **No profiles**: if the user has no engine profiles, open a plain
   conversation directly.
2. **Default set**: if the user has set a `defaultEngineProfileId` and
   the profile still exists, use it directly.
3. **Show picker**: otherwise show the picker (plain option plus
   available profiles).

## Rationale

**Follows opinionless mechanics.** The engine owns the sealed-config
mechanism: it loads enterprise config from the platform source (MDM,
Group Policy, environment variable), applies it as a constraint layer,
and exposes it via RPC. The specific policy -- what the default working
directory and profile should be -- is a consumer opinion. Administrators
set the opinion via enterprise config; the engine enforces the
mechanism without hardcoding any particular default.

**Engine RPC keeps clients decoupled from MDM.** If clients parsed MDM
plist or registry keys directly, each client would need platform-specific
MDM reading code. Exposing the resolved policy via `get_enterprise_policy`
means clients receive the already-merged, already-validated policy value
regardless of how it was delivered to the engine.

**`desktop_settings_snapshot` is the existing iOS settings channel.**
iOS already receives user preferences and available models through
`desktop_settings_snapshot`. Adding `newConversationPolicy` there follows the
existing pattern and avoids a new iOS-specific RPC.

**Runtime precedence, not UI disablement.** When `locked` is `true`, the
policy is enforced at the new-conversation routing layer. Every entry
point resolves to the locked action before any picker or preference is
consulted. The settings controls themselves are not disabled in the UI --
the lock is a runtime behavior, not a UI gate. This keeps the
implementation focused on the decision point (new-conversation routing)
and avoids UI-state management for the lock condition.

## Consequences

- `EnterpriseConfig` gains the `newConversationDefaults` field. The enterprise
  merge, contract manifest, and cross-language type mirrors (TypeScript,
  Swift) are updated.
- The engine dispatch loop gains the `get_enterprise_policy` case.
  The response carries only `newConversationDefaults`; the full enterprise config
  is not exposed via this RPC.
- Desktop fetches the policy at startup via `engine-bridge-fs.ts` and
  stores it alongside the settings snapshot.
- iOS decodes `newConversationPolicy` from `desktop_settings_snapshot` and stores
  it on `SessionViewModel`.
- Both clients implement `resolveNewConversationAction` (desktop TS) /
  `resolveNewConversationAction` (iOS Swift, a free function in
  `NewConversationRouting.swift`) with the same
  four-state decision tree. The locked state is handled at the top.
- When `locked: false` (or `locked` is absent), the policy is treated
  as a suggestion. The client uses the user's own preferences and falls
  back to the policy values only when the user has not made a choice.
