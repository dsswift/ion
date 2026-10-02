---
title: Sealed Configuration
description: How enterprise config seals values and prevents override by user or project configuration.
sidebar_position: 3
---

# Sealed Configuration

Enterprise configuration is not just another config layer. It is a constraint layer. Values set at the enterprise level cannot be weakened by user or project configuration. The engine enforces this by applying enterprise config after the three-layer merge (defaults, user, project) is complete.

Sealing constrains the settings it names. To own a whole configuration file instead, including settings added in later engine releases, use [managed configuration files](managed-config.md). The two work together.

## Sealing semantics

Different field types have different sealing behaviors:

### Restrictive fields (can only tighten)

These fields restrict what is available. Lower layers cannot expand them.

| Field                                   | Sealing behavior                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedModels`                         | If set, only these models can be used. Lower layers cannot add models to the list.                                                                                                                                                                                                                        |
| `blockedModels`                         | These models are always blocked. Lower layers cannot remove models from the list.                                                                                                                                                                                                                         |
| `allowedProviders`                      | If set, only these providers can be used.                                                                                                                                                                                                                                                                 |
| `permissions.mode`                      | Can only move toward more restrictive: `allow` < `ask` < `deny`. Enterprise `ask` means user/project cannot set `allow`.                                                                                                                                                                                  |
| `toolRestrictions.deny`                 | Tools on this list are always denied. Lower layers cannot remove entries.                                                                                                                                                                                                                                 |
| `sandbox.required`                      | If `true`, sandbox cannot be disabled.                                                                                                                                                                                                                                                                    |
| `sandbox.allowDisable`                  | If `false`, the `sandbox.enabled` field is locked.                                                                                                                                                                                                                                                        |
| `security.requirePrincipalPartitioning` | If `true`, `security.principalPartitioning.enabled` cannot be set to `false` (ADR-034).                                                                                                                                                                                                                   |
| `security.minEnforcement`               | Raises the effective partitioning enforcement to at least this level (`none` < `read-only` < `strict`). A lower layer may configure something stricter; it can never soften below this floor. An unrecognized enforcement value ranks as `none` so a malformed config can never satisfy a stricter floor. |
| `git.required`                          | If `true`, a session with no resolvable git author identity refuses a commit-recording Bash call rather than stamping one unattributed.                                                                                                                                                                   |

### Additive fields (union merge)

These fields accumulate values from all layers. Enterprise values are always included.

| Field                                 | Sealing behavior                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `permissions.rules`                   | Enterprise rules are prepended to the rule list (evaluated first).                                                   |
| `permissions.dangerousPatterns`       | Enterprise patterns are added to the pattern list.                                                                   |
| `permissions.readOnlyPaths`           | Enterprise paths are added to the read-only list.                                                                    |
| `sandbox.additionalDenyPaths`         | Merged into the sandbox deny list.                                                                                   |
| `sandbox.additionalDangerousPatterns` | Enforced on every session, with the sandbox on or off. Added to the built-in sandbox patterns, never replacing them. |
| `mcpDenylist`                         | Denied servers are always blocked. Lower layers cannot remove entries.                                               |

### Override fields (enterprise replaces)

These fields, when set at the enterprise level, replace any value from lower layers entirely.

| Field                     | Sealing behavior                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                 | Enterprise network config (proxy, CA certs, TLS) replaces all lower-layer network settings.                                                                                                                      |
| `telemetry`               | Enterprise telemetry config replaces lower layers. If `enabled: true`, it cannot be disabled.                                                                                                                    |
| `requiredHooks`           | These hooks must be active. Extensions cannot deregister them.                                                                                                                                                   |
| `newConversationDefaults` | When non-null, replaces the base value. A null overlay preserves the base value. When `locked: true`, clients skip the profile and directory pickers for new conversations and use the mandated values.          |
| `subscriptionLookup`      | When set, replaces the user and project block whole, so the endpoint that issues provider keys cannot be redirected by a lower layer. See [Subscription Lookup](../configuration/subscription-lookup.md).        |
| `git.machine`             | When set, replaces the user-layer `git.identity.machine` fallback wholesale — the enterprise-mandated author identity, used whenever `fromPrincipal` is false or a principal's own name/email can't be resolved. |

### Per-principal fields (`toolRestrictions.principals`)

`toolRestrictions.principals[]` is a fourth category the three above don't quite cover: rules scoped to a matching principal (by subject, provider, or claim), evaluated after the layer-restrictive `toolRestrictions.allow`/`deny` above and unioned across every matching rule. The precedence, in order:

1. The restrictive `toolRestrictions.deny`/`allow` lists above are checked first. An enterprise-wide deny always wins, even over a principal-specific allow.
2. Every `principals[]` entry whose `match` matches the calling principal is then consulted. Deny wins across matching rules.
3. When at least one matching rule declares a non-empty `allow`, the tool must be in the intersection of every matching rule's `allow` list — one rule's silence on `allow` does not widen another's.
4. A principal matched by no rule falls through to the global policy alone.

A `match` with every field empty matches every principal — the operator's own mistake to notice, not something the engine rejects. `toolRestrictions.principals[]` exists only in the sealed enterprise config — there is no user-layer equivalent in `engine.json`. Each entry:

```jsonc
{
  "match": {
    "subjects": ["alice@example.com"],
    "providers": ["entra"],
    "claims": { "groups": ["eng"] },
  },
  "allow": ["Read", "Grep"],
  "deny": ["Bash"],
}
```

`match`'s fields are each optional and act as a wildcard when empty: `subjects`/`providers` match by exact string, `claims` requires the principal's session claims to contain the named key with a value in the given set. See [ADR-034](../architecture/adr/034-principal-isolation-and-tenancy.md) for the design rationale.

### Filtering fields (post-merge filter)

These fields act as filters applied after the merge.

| Field                         | Sealing behavior                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpAllowlist`                | After merge, any MCP server not on this list is removed from the final config.                                                                            |
| `toolRestrictions.allow`      | If set, only these tools are available. All others are removed.                                                                                           |
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

It behaves differently from every other field on this page, because it is the only one where the layers _below_ enterprise merge additively with each other while still being hard-capped from above.

### The two mechanisms

Two separate things happen, in this order:

1. **User and project merge additively (union).** `~/.ion/engine.json` and the repo's `.ion/engine.json` are unioned, dropping duplicates and preserving order. Neither replaces the other.
2. **Enterprise intersects the result (ceiling).** If enterprise sets the field, the merged union is filtered down to the commands the enterprise sanctions.

Step 1 is a **portability mechanism**, not a security control. It exists so a repository can declare the commands its workflow needs without knowing what any individual developer already allows globally. Step 2 is the **security boundary**.

The pairing is the design: step 1 is deliberately permissive and is only safe because step 2 runs after it.

### Why user and project are additive

A committed `.ion/engine.json` cannot know each developer's personal list. If the project layer _replaced_ the user layer, every repo would have to restate every developer's global entries or silently strip them. Union means a repo adds what it needs and each developer keeps what they had.

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

Entries are command _prefixes_, so intersection has to decide what counts as "sanctioned by" a ceiling entry. The rule:

| Ceiling entry | Lower-layer entry | Result       | Why                                                                                                              |
| ------------- | ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `gh`          | `gh pr view`      | **kept**     | Narrower form. `gh` already permits every `gh ...` invocation, so keeping the specific entry grants nothing new. |
| `gh pr view`  | `gh`              | **stripped** | Generalising outward. Keeping it would permit `gh repo delete`, which the ceiling excluded.                      |
| `git`         | `git log`         | **kept**     | Genuine sub-command.                                                                                             |
| `git`         | `github-cli-doer` | **stripped** | Prefix-string coincidence, not a sub-command. A match requires the next character to be a space.                 |

The asymmetry in rows 1 and 2 is the security property. If it ran both ways, any ceiling entry could be generalised up to its bare command and the policy would be advisory.

### Writing an effective ceiling

Because narrower entries are retained, **write the ceiling at the broadest level you are willing to permit**, not at the level you expect developers to use.

- Ceiling `["gh"]` permits every `gh` sub-command that any lower layer names. Use it when `gh` as a whole is acceptable.
- Ceiling `["gh pr view", "gh pr diff"]` permits only those two. A project asking for `gh` gets nothing.

An explicit empty list (`[]`) is a real policy meaning "no Bash in plan mode, ever," and strips every lower-layer entry. Omitting the field entirely (or `null`) means "no policy on this axis" and leaves the user+project union untouched. These two are not the same — the distinction is deliberate and load-bearing.

### Observability

Every stripped entry is recorded as a `plan_mode_bash_pruned` enforcement action, with the rejected command as the subject and the reason. Without this an operator whose project config had no effect would have no way to discover why. Enforcement actions are drained at serve startup and on each enterprise config reload; see [Compliance](compliance.md).

## Policy override notices

Enforcement replaces and removes values a user or project configured. So that a client can say why a configured value is not the one in effect, the engine records each displaced value on the policy it returns from [`get_enterprise_policy`](../protocol/client-commands.md#get_enterprise_policy), under `policy.overrides`:

```json
{
  "overrides": [
    {
      "field": "providers.gateway.baseURL",
      "reason": "managed_provider_pinned",
      "userValue": "https://other.example.org/v1",
      "effectiveValue": "https://gateway.example.org/v1"
    },
    { "field": "providers.extra", "reason": "provider_not_allowed" }
  ]
}
```

| Reason                    | Field                       | Recorded when                                                                                    |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `managed_provider_pinned` | `providers.<key>.<setting>` | An enterprise `providers` entry replaced that setting of the lower-layer entry for the same key. |
| `provider_not_allowed`    | `providers.<key>`           | `allowedProviders` removed a lower-layer provider.                                               |
| `model_not_allowed`       | `defaultModel`              | `allowedModels` does not name the lower-layer default model.                                     |
| `model_blocked`           | `defaultModel`              | `blockedModels` names the lower-layer default model.                                             |
| `mcp_server_denied`       | `mcpServers.<key>`          | `mcpDenylist` removed a lower-layer MCP server.                                                  |
| `mcp_server_not_allowed`  | `mcpServers.<key>`          | `mcpAllowlist` did not admit a lower-layer MCP server.                                           |

- A notice exists only when the value in effect differs from the one the lower layer supplied. A lower-layer value equal to the policy value, or a setting the lower layer never set, produces none.
- `field` is the path in `engine.json` key spelling. `reason` is a stable code; the engine ships no presentation text.
- `userValue` and `effectiveValue` are omitted for a removed entry and for `apiKey`. A `baseURL` is reported without userinfo, query, or fragment; when two URLs differ only there, both values are omitted.
- The list is sorted by `field`, is part of the policy blob, and so changes `policyHash` when it changes.
- The engine computes the list. A policy source that carries an `overrides` key has it discarded.
- The list describes the config the daemon loaded at start: the user-level `engine.json` against the enterprise policy.

Ion Studio shows the provider notices on the Providers & models page and the MCP notices on the MCP servers list.

## Extension allowlist

`extensionAllowlist` limits which extensions the engine loads. Each entry names one extension:

```json
{
  "extensionAllowlist": [
    { "id": "storage-sync", "sha256": "9f2c..." },
    { "id": "review-helper" }
  ]
}
```

| Field    | Description                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`     | The extension identifier: the `name` in its `extension.json`, else its directory name.                            |
| `sha256` | Optional. The hex SHA-256 of the extension's entry-point file. A mismatch blocks the load even when `id` matches. |

An empty or absent list loads every extension. A non-empty list blocks every extension it does not name, before the extension runs. A blocked load surfaces as an `engine_error` with `errorCode: "extension_blocked"` and records an `enforcement.extension_blocked` telemetry event with the identifier and the reason: `name` when the list does not name it, `hash` when the pinned hash did not match.

The error's `message` is engine text by default. Set `messages.extension_blocked` to replace it with your own, for example where to request an extension. The replacement changes the text only: the block, the `errorCode`, and the telemetry event are the same. The blocked identifier stays on the event as `extensionName`. See [Policy messages](policy-messages.md).

```json
{
  "extensionAllowlist": [{ "id": "example-ext" }],
  "messages": {
    "extension_blocked": "Extensions are managed by your IT department. Request one at https://servicedesk.example.org."
  }
}
```

The `id` an extension matched is its trusted identity. The engine keys each extension's section of [application config](../configuration/engine-json.md#application-config-document) on it. The name an extension reports about itself at startup does not change it.

## Account policies

A host that serves more than one person can carry different policy for different accounts. The rest of this page describes one policy for the whole machine. `accountPolicies` adds policy that applies only to the accounts an entry selects.

```jsonc
{
  "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  "accountPolicies": [
    {
      "name": "contractors",
      "match": { "osGroups": ["Contractors"] },
      "assetScope": "contractors",
      "policy": {
        "allowedModels": ["claude-haiku-4-5-20251001"],
        "permissions": { "mode": "ask" },
        "resourceLimits": { "maxAgentsPerSession": 2 }
      }
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `name` | Optional label, used in the engine log. |
| `match` | Which accounts the entry applies to. See [Matching an account](#matching-an-account). |
| `assetScope` | Optional. Names a scope for on-disk assets delivered to the matched accounts only. One lowercase directory name: `^[a-z0-9][a-z0-9-]{0,63}$`. See [Account-scoped assets](#account-scoped-assets). |
| `policy` | The policy for the matched accounts. It uses the same keys as the machine policy. |

### Where account policies are read from

Account policies are part of the machine policy. The engine reads them from the same administrator-controlled source as everything else on this page (see [MDM Deployment](mdm.md#source-resolution-order)) and from nowhere else. No per-user location is a source: the per-user layer still contributes only `customFields['ion-desktop'].environments`, and an `accountPolicies` key written there is ignored and logged.

On Linux and Windows each drop-in file can carry its own `accountPolicies`. The lists accumulate across files, so one group's policy can live in one file.

### Matching an account

Every non-empty `match` field must match. An empty field matches anything, and a `match` with every field empty selects every account.

| Field | Matches |
|-------|---------|
| `osUsers` | The operating-system account the engine runs as, by user name or stable id (a uid, or a SID on Windows). On Windows `DOMAIN\name` and the bare `name` both match. Names compare without regard to case. |
| `osGroups` | Any group that account belongs to, by group name or stable id (a gid, or a SID on Windows). On Windows the groups come from the sign-in token, so a directory group with no local group entry still matches by SID. |
| `subjects`, `providers`, `claims` | The session's principal, exactly as [`toolRestrictions.principals`](#per-principal-fields-toolrestrictionsprincipals) matches it. |

The two kinds of field are trusted differently. The engine reads the OS account from the operating system, so nothing a client sends can change it. A principal reaches the engine from the client that started the session, so a principal match is as trustworthy as that client. On a host where each person runs their own engine, match by `osUsers` or `osGroups`. Match by principal on a shared server that verifies each person before it starts their sessions.

An entry applies at one of two scopes:

- **Process scope.** An entry that names only `osUsers` or `osGroups` is resolved once, for the engine process. Every field in its `policy` applies.
- **Session scope.** An entry that names `subjects`, `providers`, or `claims` is resolved for each session, against that session's principal. Two sessions for different principals on one engine each get their own policy, and neither sees the other's. A session with no principal matches no such entry and gets the process policy.

A session-scoped entry can only carry the fields the engine applies per session. These configure things that exist once per engine process, so the engine ignores them in a session-scoped entry and logs a warning: `auth`, `subscriptionLookup`, `providers`, `allowedProviders`, `pluginAllowlist`, `pluginDenylist`, `pluginForceInstalled`, `telemetry`, `systemMetrics`, `applicationConfig`, `protectedOperations`, `conversationEvents`, `network`, `logging`, `security`, `thinking`, and `resourceLimits.maxSessions`. Put them in an entry that matches by OS account only.

### How an account policy composes with the machine policy

The machine policy is the ceiling. An account policy can restrict further. It can never relax a machine constraint. A value that would relax one is ignored, logged as `account policy value ignored`, and the machine value stands.

Matching entries apply in the order written: process-scope entries first, then session-scope entries. Each one composes with the result of the ones before it, so the same inputs always give the same policy.

Every field belongs to one of four classes.

**Allowlists: the account list is cut down to what the machine list permits.**

| Field | Rule |
|-------|------|
| `allowedModels`, `allowedProviders`, `toolRestrictions.allow` | An account entry that is not in the machine list is ignored. |
| `mcpAllowlist`, `pluginAllowlist` | An account entry is kept when the machine list names it or a machine pattern matches it. An account pattern is kept only when the machine list names the same pattern. |
| `extensionAllowlist` | An account entry is kept when the machine list names the same `id`. A machine `sha256` stands. An account `sha256` applies where the machine entry has none. |
| `limits.planModeAllowedBashCommands`, `limits.planModeAllowedMcpTools` | The account list is intersected with the machine list by the same [prefix rule](#prefix-matching-runs-one-direction). An empty result means none are allowed. |

When the machine does not set an allowlist, the account list applies as written. When no account entry is inside the machine list, the account list is a mistake: the engine ignores it whole and the machine list stands. The plan-mode lists are the exception, because for them an empty list is a real value.

**Deny lists and additive lists: union.**

| Field | Rule |
|-------|------|
| `blockedModels`, `mcpDenylist`, `pluginDenylist`, `toolRestrictions.deny` | Both lists apply. |
| `pluginForceInstalled`, `requiredHooks`, `toolRestrictions.principals` | Both lists apply. |
| `permissions.dangerousPatterns`, `permissions.readOnlyPaths`, `sandbox.additionalDenyPaths`, `sandbox.additionalDangerousPatterns` | Both lists apply. |
| `permissions.rules` | An account `deny` rule is evaluated before the machine rules. An account `ask` rule is evaluated after them, and is ignored when the mode is `deny`. An account `allow` rule is ignored. |
| `permissions.tierRules` | The stricter decision wins for a tier both set. An account `allow` for a tier the machine does not set is ignored. |
| `protectedOperations` | The account adds operations. A machine operation of the same name stands. |

**One-way switches and bounds: the stricter value wins.**

| Field | Rule |
|-------|------|
| `permissions.mode` | `allow` < `ask` < `deny`. |
| `sandbox.required`, `security.requirePrincipalPartitioning`, `git.required`, `thinking.disabled`, `telemetry.enabled`, `conversationEvents.enabled`, `auth.requireOperatorIdentity`, `newConversationDefaults.locked`, `newConversationDefaults.profileLocked`, `disableTelemetryHealthNotifications` | On when either sets it. |
| `sandbox.allowDisable` | Allowed only when both allow it. |
| `security.minEnforcement` | The stricter level. |
| `resourceLimits.maxSessions`, `resourceLimits.maxAgentsPerSession`, `limits.agentStateMetadata`, `conversationRetentionDays` | The lower number. |

**Managed values: the account value wins when present.** These supply endpoints, defaults, and identity. Differing per account is their purpose, so they are not constraints the machine holds as a ceiling.

| Field | Rule |
|-------|------|
| `newConversationDefaults`, `subscriptionLookup`, `systemMetrics`, `applicationConfig`, `logging`, `auth`, `telemetry`, `conversationEvents` | The account block replaces the machine block. A one-way switch inside it keeps the stricter value, as above. |
| `network` | `proxy` and `customCaCerts` are each replaced when the account sets them. |
| `git.machine` | Replaced when the account sets it. |
| `providers` | The account adds or replaces provider definitions by key. A key the machine `allowedProviders` excludes is ignored. |
| `customFields` | Merged key by key. Nested objects merge; any other value is replaced. |

### Account-scoped assets

An asset an administrator installs for the whole machine reaches every account on it. `assetScope` lets an asset reach some accounts only.

The engine does not read assets. It reports, on the resolved policy, the `assetScopes` of every account policy that matched the account. A consumer maps a scope to its own on-disk location. Ion Studio looks for theme packs in `accounts/<scope>/themes` beside the machine themes root, so a pack installed there is offered only to accounts whose policy names that scope. See [Theme Packs](../design/theme-packs.md#install-locations).

`assetScopes` is set by the engine. A policy source cannot set it.

### What a consumer sees

`get_enterprise_policy` returns the resolved policy for the account it is asked about. The reply never carries `accountPolicies`, so one account's reply does not reveal another account's policy. See [`get_enterprise_policy`](../protocol/client-commands.md#get_enterprise_policy).

### A host with no account policies

Nothing changes. With no `accountPolicies` in the machine policy, the machine policy applies exactly as before and no configuration is needed.

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

The `ion-server` key is the Studio Server's namespace in the same way. Both namespaces take a `settingsPolicy` block that classifies settings key by key; see [Settings policy](settings-policy.md).
