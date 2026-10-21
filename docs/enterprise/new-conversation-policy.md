---
title: New-Conversation Policy
description: Enterprise control over working directory and engine profile for new conversations.
sidebar_position: 7
---

# New-Conversation Policy

The `newConversationDefaults` enterprise config field lets administrators set an organization-wide default working directory and engine profile for every new conversation. When the `locked` flag is set, the policy takes runtime precedence: every new-conversation entry point opens with the mandated directory and profile regardless of what the user's own default-directory and default-profile settings say. When the lock names a `baseDirectory`, the controls that offer a folder, a project, or a profile are not shown (see [Controls hidden when locked](#controls-hidden-when-locked)).

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

A client calls this RPC during startup to determine whether its new-conversation flow should be locked.

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
| `locked` | boolean | When `true`, the policy takes runtime precedence. Every new-conversation entry point opens with the mandated `baseDirectory` and `engineProfileId`, ignoring the user's own default-directory and default-profile settings. When `baseDirectory` is set, the controls that offer a folder, a project, or a profile are hidden (see [Controls hidden when locked](#controls-hidden-when-locked)). |

### Sealing behavior

`newConversationDefaults` is an **override field**: when the enterprise overlay sets it to a non-null value, it replaces any base value. When the overlay does not set `newConversationDefaults` (null pointer), the base value is preserved. See [Sealed config](sealed-config.md) for the full overlay semantics.

## Client behavior when locked

When `locked` is `true`, a client skips its profile picker and directory picker entirely and opens the conversation directly with the mandated values. The user's default-directory and default-profile settings are ignored at new-conversation creation time.

Empty `engineProfileId` with `locked: true` is valid. It means a plain conversation (no extensions) is mandated. Users cannot switch to an extension profile.

## Controls hidden when locked

A lock that names a `baseDirectory` takes folder and project choice away. The archived Ion Studio hid these controls while it was in force, and a client with the same surfaces should do the same:

| Where | Control hidden |
|-------|----------------|
| New conversation | The project list, the New project row, the branch step, and the profile picker. The conversation opens straight into `baseDirectory` on `engineProfileId`. |
| Inbox sidebar | The New project button. |
| Title bar | The project name stops being a button that opens the new-conversation picker, and the terminal folder picker (Ctrl+Alt click) does not open. |
| Conversation | The Choose folder button in an empty conversation. |
| Explorer | The Add Folder to Workspace button. |
| Settings | The Projects section (add, clone, change location, remove, default project, profile per project) and the Engine profiles section. |
| Send in the background | The fresh conversation opens in `baseDirectory` on `engineProfileId`, with no worktree and no other machine's checkout. |

A lock with an empty `baseDirectory` (a profile lock only) hides none of these: the person still chooses where.

Left visible because it only reads: the Explorer tree of the locked folder, the project scope filter in the Inbox, and each conversation's profile badge.

## Enforcement when locked

The engine applies the profile lock itself, and a client that fronts the engine should apply the directory lock the same way, so a client that ignores it is refused rather than trusted. The archived Ion Studio server did:

- `createConversationTab` opens every new conversation in `baseDirectory` on `engineProfileId`, whatever directory, profile, or worktree the caller asked for. A restore keeps what it recorded.
- The engine forces the locked profile onto every session it starts.
- `environment.projects.add`, `environment.projects.clone`, `environment.projects.remove`, `environment.projects.relocate`, `setBaseDirectory`, and `addDirectory` are refused with `policy_locked`, only when the lock names a `baseDirectory`.
- A conversation the server opens by itself (a person's last one was closed or settled) follows the same directory and profile.

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

Result: `baseDirectory` and `engineProfileId` are pushed to the engine, but clients treat them as suggestions. A client honors the user's own preferences if the user has set them, and falls back to these values only when the user has not made a choice.
