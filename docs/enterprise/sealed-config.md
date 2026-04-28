---
title: Sealed Configuration
description: How enterprise config seals values and prevents override by user or project configuration.
sidebar_position: 3
---

# Sealed Configuration

Enterprise configuration is not just another config layer. It is a constraint layer. Values set at the enterprise level cannot be weakened by user or project configuration. The engine enforces this by applying enterprise config after the three-layer merge (defaults, user, project) is complete.

## Sealing semantics

Different field types have different sealing behaviors:

### Restrictive fields (can only tighten)

These fields restrict what is available. Lower layers cannot expand them.

| Field | Sealing behavior |
|-------|-----------------|
| `allowedModels` | If set, only these models can be used. Lower layers cannot add models to the list. |
| `blockedModels` | These models are always blocked. Lower layers cannot remove models from the list. |
| `allowedProviders` | If set, only these providers can be used. |
| `permissions.mode` | Can only move toward more restrictive: `allow` < `ask` < `deny`. Enterprise `ask` means user/project cannot set `allow`. |
| `toolRestrictions.deny` | Tools on this list are always denied. Lower layers cannot remove entries. |
| `sandbox.required` | If `true`, sandbox cannot be disabled. |
| `sandbox.allowDisable` | If `false`, the `sandbox.enabled` field is locked. |

### Additive fields (union merge)

These fields accumulate values from all layers. Enterprise values are always included.

| Field | Sealing behavior |
|-------|-----------------|
| `permissions.rules` | Enterprise rules are prepended to the rule list (evaluated first). |
| `permissions.dangerousPatterns` | Enterprise patterns are added to the pattern list. |
| `permissions.readOnlyPaths` | Enterprise paths are added to the read-only list. |
| `sandbox.additionalDenyPaths` | Merged into the sandbox deny list. |
| `sandbox.additionalDangerousPatterns` | Merged into the dangerous patterns list. |
| `mcpDenylist` | Denied servers are always blocked. Lower layers cannot remove entries. |

### Override fields (enterprise replaces)

These fields, when set at the enterprise level, replace any value from lower layers entirely.

| Field | Sealing behavior |
|-------|-----------------|
| `network` | Enterprise network config (proxy, CA certs, TLS) replaces all lower-layer network settings. |
| `telemetry` | Enterprise telemetry config replaces lower layers. If `enabled: true`, it cannot be disabled. |
| `requiredHooks` | These hooks must be active. Extensions cannot deregister them. |

### Filtering fields (post-merge filter)

These fields act as filters applied after the merge.

| Field | Sealing behavior |
|-------|-----------------|
| `mcpAllowlist` | After merge, any MCP server not on this list is removed from the final config. |
| `toolRestrictions.allow` | If set, only these tools are available. All others are removed. |

## Evaluation order

1. The engine loads defaults, user config, and project config using standard merge rules (last writer wins for scalars, key merge for maps).
2. The merged config is complete.
3. Enterprise config is applied as constraints on the merged result:
   - Restrictive fields filter the merged values.
   - Additive fields are unioned.
   - Override fields replace.
   - Filtering fields remove disallowed entries.
4. The final config is immutable for the session lifetime.

## Example: permission mode sealing

Enterprise sets `permissions.mode` to `"ask"`:

```json
{
  "enterprise": {
    "permissions": {
      "mode": "ask"
    }
  }
}
```

User config sets `permissions.mode` to `"allow"`:

```json
{
  "permissions": {
    "mode": "allow"
  }
}
```

Result: the effective mode is `"ask"`. The user's `"allow"` is weaker than the enterprise's `"ask"`, so the engine keeps `"ask"`.

If the user had set `"deny"`, that would be honored -- it is more restrictive than `"ask"`.

## Example: model allowlist

Enterprise sets `allowedModels`:

```json
{
  "enterprise": {
    "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
  }
}
```

User config sets `defaultModel` to `"gpt-4o"`:

```json
{
  "defaultModel": "gpt-4o"
}
```

Result: `"gpt-4o"` is not in the allowed list. The engine rejects it and falls back to the first allowed model (`"claude-sonnet-4-6"`).

## Custom fields

The `customFields` map is a pass-through for organization-specific metadata. The engine does not interpret these values. Extensions can read them from the config context for custom enterprise logic.

```json
{
  "enterprise": {
    "customFields": {
      "orgId": "acme-corp",
      "costCenter": "engineering",
      "approvalRequired": true
    }
  }
}
```
