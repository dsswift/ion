---
title: Settings Policy
description: Classify any setting as user-adjustable, managed-default, or sealed, and read back the class in force.
sidebar_position: 8
---

# Settings Policy

A settings policy decides, key by key, who owns a setting's value. It needs no code per setting: any settings key can be named.

## The three classes

| Class | What it means |
|-------|---------------|
| `user-adjustable` | The person sets it freely. |
| `managed-default` | The policy supplies a value. The person may change it afterwards. When the policy later carries a different value, that value is supplied again. |
| `sealed` | The policy fixes the value. A write is refused and the control in Settings is locked. With no `value`, the value in force when the seal applied stays. |

A setting the person must not change is `sealed`, never `managed-default`.

## Where the block goes

A `settingsPolicy` block lives in the namespace of whoever stores the setting, because that is who enforces it. Every setting has one scope; see [Settings scopes](../configuration/settings-scopes.md).

| Namespace | Governs | Enforced for |
|-----------|---------|--------------|
| `customFields["ion-server"].settingsPolicy` | Environment and Account settings | Every connection to that server, admin included |
| `customFields["ion-desktop"].settingsPolicy` | Personal and Device settings | The desktop the policy is installed on. It never narrows a client visiting from another machine. |

A key named in the wrong namespace is not enforced. The applied state lists it under `ignoredKeys`, so the mistake is visible.

```json
{
  "customFields": {
    "ion-server": {
      "settingsPolicy": {
        "version": "2026-10",
        "defaultClass": "sealed",
        "keys": {
          "gitOpsMode": { "class": "sealed", "value": "worktree" },
          "commitCommand": { "class": "managed-default", "value": "commit --smart" },
          "preferredModel": { "class": "user-adjustable" }
        }
      }
    },
    "ion-desktop": {
      "settingsPolicy": {
        "defaultClass": "sealed",
        "keys": {
          "selectedTheme": { "class": "user-adjustable" },
          "studioTheme": { "class": "user-adjustable" }
        }
      }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `version` | Your own label for this revision. Reported back, never interpreted. |
| `defaultClass` | The class of every setting the block does not name. Absent means `user-adjustable`. |
| `keys.<key>.class` | The class of one setting. |
| `keys.<key>.value` | The value the policy supplies, for `managed-default` and `sealed`. |

Key names are the ones in the settings registry (`packages/shared/src/settings-registry.ts`).

## The default class

`defaultClass` covers every registered setting the block does not name. Set it to `sealed` and a setting added by a later release is sealed until you open it. Nothing becomes adjustable by omission.

Two kinds of key are outside the default:

- What the app records on its own as a person works: a panel height, a recent-folder list, an unsent draft. The registry marks these `recorded`. Sealing them by default would stop the app from working, so only naming one governs it.
- A key the registry does not know. It can be classified by name, and only by name.

With no `settingsPolicy` block, every key is user-adjustable and nothing changes.

## Malformed entries fail closed

A class that is not one of the three, an entry that is not an object, or an unknown `defaultClass` all read as `sealed`.

A policy value of the wrong type for its setting is not applied. The stored value stays in force and the key stays sealed.

## What a sealed setting does

- A write is refused on every path: the Settings dialog, a direct call to the server, the plan-mode Bash list, and a write to the desktop's own settings file. The refusal carries the code `settings_sealed`, the keys, and the class.
- The stored value does not change. The server keeps a sealed key as it is on disk whichever of its own writers runs, and logs that it did.
- The control in Settings is locked and says the setting is set by your organization.
- With a `value`, that value is in force everywhere the setting is read. The value the person had saved is kept on disk underneath and is back when the seal lifts.

## What a managed default does

The value is written once. The person may then change it, and their change survives every later launch.

When the policy carries a different value, the new value is written once more. For an Account setting, each person's own value is cleared so the new default reaches them; they may set it again.

## The two older policy blocks

`themePolicy` and `agentSettingsEdits` keep working unchanged. They resolve through the same classes:

| Block | Same as |
|-------|---------|
| `ion-desktop.themePolicy` with `locked: true` | `selectedTheme` sealed with a value |
| `ion-desktop.themePolicy` without `locked` | `selectedTheme` managed-default |
| `ion-server.agentSettingsEdits` | `allowSettingsEdits` sealed with a value |

A `settingsPolicy` entry for the same key outranks the older block.

## Reading the applied state

The applied state is the class in force for every key, the namespace it came from, and a checksum of the policy that produced it. It carries no setting's value: not the policy's and not a person's.

Two ways to read it:

- **A file.** The server writes `settings-policy-state.json` in its data directory each time the policy is read. A management system reads it without a connection.
- **The wire.** The `settings.policyState` action answers the same state. See [Studio wire](../protocol/studio-wire.md).

```json
{
  "schemaVersion": 1,
  "checksum": "sha256:…",
  "namespaces": {
    "ion-server": { "version": "2026-10", "defaultClass": "sealed" },
    "ion-desktop": { "version": null, "defaultClass": "sealed" }
  },
  "keys": {
    "gitOpsMode": { "class": "sealed", "source": "key", "namespace": "ion-server" },
    "relayUrl": { "class": "sealed", "source": "default", "namespace": "ion-server" },
    "selectedTheme": { "class": "user-adjustable", "source": "key", "namespace": "ion-desktop" }
  },
  "ignoredKeys": [],
  "appliedAt": "2026-10-01T00:00:00.000Z"
}
```

`source` says why a key has its class: `key` (named in the block), `default` (the default class), `themePolicy` or `agentSettingsEdits` (an older block), or `none` (no policy reaches it).

The checksum covers the settings inputs of the policy only. Two machines with the same checksum resolve every key the same way.

## Different populations

The enterprise config is resolved per machine, with a per-user layer on top. Deploy a different `settingsPolicy` to each population through your management channel. One build serves all of them.
