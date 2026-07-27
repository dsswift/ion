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
| `newConversationDefaults` | When non-null, replaces the base value. A null overlay preserves the base value. When `locked: true`, clients skip the profile and directory pickers for new conversations and use the mandated values. |

### Filtering fields (post-merge filter)

These fields act as filters applied after the merge.

| Field | Sealing behavior |
|-------|-----------------|
| `mcpAllowlist` | After merge, any MCP server not on this list is removed from the final config. |
| `toolRestrictions.allow` | If set, only these tools are available. All others are removed. |
| `planModeAllowedBashCommands` | After merge, any plan-mode Bash command not sanctioned by this list is removed. Prefix-aware — see [Plan-mode Bash allowlist](#plan-mode-bash-allowlist). |

## Evaluation order

1. The engine loads defaults, user config, and project config using standard merge rules (last writer wins for scalars, key merge for maps). A small number of fields merge additively across these layers rather than replacing — `limits.planModeAllowedBashCommands` is one; see [Plan-mode Bash allowlist](#plan-mode-bash-allowlist).
2. The merged config is complete.
3. Enterprise config is applied as constraints on the merged result:
   - Restrictive fields filter the merged values.
   - Additive fields are unioned.
   - Override fields replace.
   - Filtering fields remove disallowed entries.
4. The final config is immutable for the session lifetime.

The ordering is what makes step 1's permissiveness safe: no lower-layer merge behavior can widen anything, because step 3 always runs afterwards and only ever removes.

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

## Plan-mode Bash allowlist

`limits.planModeAllowedBashCommands` controls which Bash commands the model may run while a session is in plan mode. Plan mode is otherwise read-only, so this list is the one seam where a planning session can execute a shell command — which makes it the field most worth understanding before you deploy policy.

It behaves differently from every other field on this page, because it is the only one where the layers *below* enterprise merge additively with each other while still being hard-capped from above.

### The two mechanisms

Two separate things happen, in this order:

1. **User and project merge additively (union).** `~/.ion/engine.json` and the repo's `.ion/engine.json` are unioned, dropping duplicates and preserving order. Neither replaces the other.
2. **Enterprise intersects the result (ceiling).** If enterprise sets the field, the merged union is filtered down to the commands the enterprise sanctions.

Step 1 is a **portability mechanism**, not a security control. It exists so a repository can declare the commands its workflow needs without knowing what any individual developer already allows globally. Step 2 is the **security boundary**.

The pairing is the design: step 1 is deliberately permissive and is only safe because step 2 runs after it.

### Why user and project are additive

A committed `.ion/engine.json` cannot know each developer's personal list. If the project layer *replaced* the user layer, every repo would have to restate every developer's global entries or silently strip them. Union means a repo adds what it needs and each developer keeps what they had.

```jsonc
// ~/.ion/engine.json — developer's global config
{ "limits": { "planModeAllowedBashCommands": ["git log", "ls"] } }
```

```jsonc
// <repo>/.ion/engine.json — committed, travels with the clone
{ "limits": { "planModeAllowedBashCommands": ["graphify"] } }
```

Resolved on an unmanaged machine: `["git log", "ls", "graphify"]`. Every developer who clones the repo gains `graphify` in plan mode on top of their own entries, with no per-machine setup.

### Absent enterprise config, there is no ceiling

On a machine with no enterprise policy, the user+project union stands as-is. This is intentional. Absent a policy there is nothing to circumvent, and a developer configuring their own tool on their own machine is precisely what the project layer is for.

Operators should not read this as a gap. The project layer is only reachable by someone who has already cloned and chosen to run a repository's code; a repo that can run arbitrary commands at your shell does not need an `engine.json` entry to do so. The enterprise ceiling exists for the case where the organisation — not the developer — owns the policy decision.

### With enterprise config, the ceiling is absolute

When enterprise sets the field, no combination of user and project entries can widen past it.

```jsonc
// Enterprise (MDM / managed preferences)
{ "limits": { "planModeAllowedBashCommands": ["git log", "git diff", "ls"] } }
```

Given the user and project files above, the resolved list on a managed machine is `["git log", "ls"]`. The project's `graphify` is stripped, and an enforcement action is recorded for it.

Lower layers may still **narrow** further: a project that permits fewer commands than the ceiling gets fewer, and a project setting `[]` blocks Bash in plan mode entirely even when the enterprise permits commands. Enforcement only ever removes.

### Prefix matching runs one direction

Entries are command *prefixes*, so intersection has to decide what counts as "sanctioned by" a ceiling entry. The rule:

| Ceiling entry | Lower-layer entry | Result | Why |
|---|---|---|---|
| `gh` | `gh pr view` | **kept** | Narrower form. `gh` already permits every `gh ...` invocation, so keeping the specific entry grants nothing new. |
| `gh pr view` | `gh` | **stripped** | Generalising outward. Keeping it would permit `gh repo delete`, which the ceiling excluded. |
| `git` | `git log` | **kept** | Genuine sub-command. |
| `git` | `github-cli-doer` | **stripped** | Prefix-string coincidence, not a sub-command. A match requires the next character to be a space. |

The asymmetry in rows 1 and 2 is the security property. If it ran both ways, any ceiling entry could be generalised up to its bare command and the policy would be advisory.

### Writing an effective ceiling

Because narrower entries are retained, **write the ceiling at the broadest level you are willing to permit**, not at the level you expect developers to use.

- Ceiling `["gh"]` permits every `gh` sub-command that any lower layer names. Use it when `gh` as a whole is acceptable.
- Ceiling `["gh pr view", "gh pr diff"]` permits only those two. A project asking for `gh` gets nothing.

An explicit empty list (`[]`) is a real policy meaning "no Bash in plan mode, ever," and strips every lower-layer entry. Omitting the field entirely (or `null`) means "no policy on this axis" and leaves the user+project union untouched. These two are not the same — the distinction is deliberate and load-bearing.

### Observability

Every stripped entry is recorded as a `plan_mode_bash_pruned` enforcement action, with the rejected command as the subject and the reason. Without this an operator whose project config had no effect would have no way to discover why. Enforcement actions are drained at serve startup and on each enterprise config reload; see [Compliance](compliance.md).

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

The `ion-desktop` key is a desktop-owned namespace by convention: the Ion desktop reads its client-side enterprise constraints from `customFields["ion-desktop"]` (auto-update disable, theme enforcement via `themePolicy` — see [Theme Packs](../design/theme-packs.md#enterprise-enforcement)). The engine passes the namespace through without validating it.
