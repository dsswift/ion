---
title: Enterprise Configuration
description: Machine vs. per-user enterprise config layers -- what each can control.
sidebar_position: 3
---

# Enterprise Configuration

The engine merges enterprise configuration from two kinds of source, and they are not
peers. **Machine layer** is the sole enforcer: it is the only source that can lock,
restrict, or narrow anything a person may do. **Per-user layer** is additive-only: it can
offer more places to connect, and it can never loosen, remove, or narrow anything the
machine layer set.

For full source resolution, delivery mechanisms (MDM profiles, Group Policy, ProgramData,
`/etc/ion`), and deployment recipes, see [MDM Deployment](../enterprise/mdm.md). This page
covers the two-layer model and what each layer is permitted to touch.

## Machine layer

The machine layer is everything [MDM Deployment](../enterprise/mdm.md) describes:
`ION_ENTERPRISE_CONFIG`, the macOS machine-wide managed-preferences plist, Windows
ProgramData plus `HKLM\SOFTWARE\Policies\IonEngine`, and Linux `/etc/ion/config.json` plus
its drop-ins. Every `EnterpriseConfig` field can be set here: allowed/blocked models,
tool restrictions, resource limits, `customFields`, all of it. This is the only layer
that can lock a value -- a lock set here cannot be loosened by anything downstream.

On an installation carrying the [managed-mode marker](../enterprise/mdm.md#managed-mode),
`ION_ENTERPRISE_CONFIG` is not a machine-layer source: it is ignored. If no machine
source resolves there, the engine locks instead of running unrestricted.

## LAN discovery seal

`customFields['ion-studio'].lanDiscovery: "disabled"` turns LAN discovery off for the
organization. It is read on both sides by one reader
(`packages/shared/src/enterprise-lan-discovery.ts`): a Studio Server never announces
itself on the network, whatever `server.json.discovery.advertise` says and whatever a
client asks, and a desktop does not offer the Nearby door or the Discovery control.
Pairing then goes through a pairing link or another door. Absent, or any other value,
means allowed. See [LAN discovery](../deployment/studio-server.md#lan-discovery).

## Per-user layer

The per-user layer is a second, per-user source whose **only honored content** is
`customFields['ion-desktop'].environments` -- the list of Ion Studio Servers a person's
desktop should offer as managed catalog entries. Every other key found in a per-user
source is **ignored** and logged at `WARN` with the key name; it never reaches the merged
policy, regardless of what it names.

This exists so IT can provision **which servers a specific person should see**, per
person rather than per machine, without opening any door for a person-writable file to
narrow, loosen, or override machine policy. A per-user file containing `allowedModels`,
a `locked` flag, or an `environmentPolicy` block has no effect at all -- those keys are
dropped before the merge, not merely overridden.

### Per-user sources

| Platform | Source |
|----------|--------|
| macOS | `/Library/Managed Preferences/<user>/com.ion.engine.plist` -- an MDM **per-user** profile, distinct from the machine-wide plist at `/Library/Managed Preferences/com.ion.engine.plist` |
| Windows | `HKCU\SOFTWARE\Policies\IonEngine`, read permissively (not through the field-allowlisted decoder the machine layer's `HKLM` read uses) so an unrecognized key is visible to this layer's own `WARN` logging rather than silently absorbed |
| Linux | `~/.config/ion/enterprise-user.json` |

Each source is read once at startup, exactly like the machine layer. `ION_ENTERPRISE_CONFIG`
has no per-user equivalent -- on an unmanaged installation it resolves the whole machine
config outright and the per-user layer still merges its `environments` in on top.

### Merge semantics

The merged policy's `customFields['ion-desktop'].environments` is **machine entries
followed by per-user entries**, de-duplicated by `url`:

- A per-user entry whose `url` matches a machine entry's is **dropped** (logged at
  `DEBUG`) -- the machine entry always wins a collision. This matters because the
  machine entry may itself carry policy metadata (locked flags resolved elsewhere by
  the client) that a per-user duplicate would otherwise appear to override.
- A per-user entry with a unique `url` is appended after every machine entry.
- The per-user layer contributes only additional entries; it can never remove or replace
  a machine-declared environment.

### Example

Machine layer (`/etc/ion/config.json` or equivalent):

```json
{
  "customFields": {
    "ion-desktop": {
      "environments": [
        { "label": "Team A", "url": "wss://ion-a.corp.example" }
      ]
    }
  }
}
```

Per-user layer (`~/.config/ion/enterprise-user.json`):

```json
{
  "customFields": {
    "ion-desktop": {
      "environments": [
        { "label": "Personal", "url": "wss://personal.example" }
      ],
      "allowedModels": ["ignored-not-honored"]
    }
  }
}
```

`get_enterprise_policy`'s merged `customFields['ion-desktop'].environments` contains both
entries, in that order; `allowedModels` at the per-user `ion-desktop` level is dropped
and logged at `WARN`, and the top-level `EnterpriseConfig.AllowedModels` (a machine-layer
field, unrelated to the per-user `ion-desktop` block above) is whatever the machine layer
alone set.
