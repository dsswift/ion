---
title: New-Conversation Policy
description: Enterprise control over working directory and engine profile for new conversations.
sidebar_position: 7
---

# New-Conversation Policy

The `newConversationDefaults` enterprise config field lets administrators set an organization-wide default working directory and engine profile for every new conversation. When the `locked` flag is set, the policy takes runtime precedence: every new-conversation entry point opens with the mandated directory and profile regardless of what the user's own default-directory and default-profile settings say. The settings controls remain visible and editable, but have no effect on new-conversation creation while the lock is active.

## Engine RPC: `get_enterprise_policy`

Clients use the `get_enterprise_policy` RPC to read the current `newConversationDefaults` policy from the engine. The engine exposes this rather than requiring clients to parse MDM sources themselves.

**Request:**

```json
{ "cmd": "get_enterprise_policy", "requestId": "r1" }
```

A `requestId` is required to receive the `ServerResult` response (per the engine wire contract — without it the engine processes the command silently).

**Response:** a `ServerResult` with `ok: true` whose `data` carries the policy (the engine echoes `requestId` but not `cmd` on this RPC):

```json
{
  "requestId": "r1",
  "ok": true,
  "data": {
    "newConversationDefaults": {
      "baseDirectory": "/corp/projects",
      "engineProfileId": "profile-corp",
      "locked": true
    }
  }
}
```

When no enterprise config is loaded, or when the config has no `newConversationDefaults` section, `data.newConversationDefaults` is `null`:

```json
{ "requestId": "r1", "ok": true, "data": { "newConversationDefaults": null } }
```

The desktop calls this RPC during startup to determine whether the new-conversation flow should be locked. iOS does **not** call the RPC directly; it receives the resolved policy as `newConversationPolicy` in the `desktop_settings_snapshot` event, which the desktop populates from the RPC result.

## Config field: `EnterpriseConfig.newConversationDefaults`

Set in the `enterprise` block of the engine config (delivered via MDM, Group Policy, or the `ION_ENTERPRISE_CONFIG` environment variable).

```json
{
  "enterprise": {
    "newConversationDefaults": {
      "baseDirectory": "/corp/projects",
      "engineProfileId": "profile-corp",
      "locked": true
    }
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `baseDirectory` | string | Default working directory for new conversations. Empty string means no constraint -- clients use their own default. |
| `engineProfileId` | string | Default engine profile ID for new conversations. Must match an `id` in the user's engine profiles list. Empty string means plain conversation (no extensions). |
| `locked` | boolean | When `true`, the policy takes runtime precedence. Every new-conversation entry point opens with the mandated `baseDirectory` and `engineProfileId`, ignoring the user's own default-directory and default-profile settings. The settings controls are still visible and editable but have no effect on new-conversation creation while the lock is active. |

### Sealing behavior

`newConversationDefaults` is an **override field**: when the enterprise overlay sets it to a non-null value, it replaces any base value. When the overlay does not set `newConversationDefaults` (null pointer), the base value is preserved. See [Sealed config](sealed-config.md) for the full overlay semantics.

## Client behavior when locked

When `locked` is `true`, both desktop and iOS skip the profile picker and directory picker entirely and open the conversation directly with the mandated values. The user's default-directory and default-profile settings are ignored at new-conversation creation time; the settings controls themselves remain interactive.

- **Desktop**: `resolveNewConversationAction` returns `{ kind: 'locked', baseDirectory, profileId }`. The conversation opens directly with the mandated values.
- **iOS**: the free function `resolveNewConversationAction(...)` in `NewConversationRouting.swift` returns `.locked(baseDirectory:profileId:)`; the dispatch to `createTab` happens in `TabListView.swift`. The new-conversation sheet bypasses profile and directory selection.

Empty `engineProfileId` with `locked: true` is valid. It means a plain conversation (no extensions) is mandated. Users cannot switch to an extension profile.

## Example: require a specific profile, allow directory choice

```json
{
  "enterprise": {
    "newConversationDefaults": {
      "baseDirectory": "",
      "engineProfileId": "corp-security-profile",
      "locked": true
    }
  }
}
```

Result: every new conversation loads the `corp-security-profile` profile. Users can still choose their working directory (the directory picker appears normally). Locking applies to both fields together -- you cannot lock only one.

## Example: suggest defaults without locking

```json
{
  "enterprise": {
    "newConversationDefaults": {
      "baseDirectory": "/corp/projects",
      "engineProfileId": "corp-security-profile",
      "locked": false
    }
  }
}
```

Result: `baseDirectory` and `engineProfileId` are pushed to the engine, but clients treat them as suggestions. The desktop and iOS honor the user's own Settings preferences if the user has set them, and fall back to these values only when the user has not made a choice.
