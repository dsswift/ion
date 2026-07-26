---
title: Compliance Controls
description: Model allowlists, provider restrictions, tool restrictions, MCP governance, and required hooks.
sidebar_position: 6
---

# Compliance Controls

Enterprise config provides several mechanisms to restrict what the engine can do. These controls enforce organizational policy around which models, providers, tools, and external services are permitted.

All compliance controls are set in the enterprise config layer and cannot be weakened by user or project configuration.

## Model restrictions

Control which LLM models are available to users.

### Allowlist

When `allowedModels` is set, only the listed models can be used. Any model not on the list is rejected at session start.

```json
{
  "enterprise": {
    "allowedModels": [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6"
    ]
  }
}
```

If a user's configured `defaultModel` is not on the allowlist, the engine falls back to the first model in the `allowedModels` array.

### Blocklist

When `blockedModels` is set, the listed models cannot be used. All other models are permitted.

```json
{
  "enterprise": {
    "blockedModels": [
      "gpt-4o",
      "gpt-4-turbo"
    ]
  }
}
```

If both `allowedModels` and `blockedModels` are set, `allowedModels` takes precedence. The blocklist is only useful when you want to ban specific models while allowing everything else.

## Provider restrictions

Limit which LLM providers the engine can connect to.

```json
{
  "enterprise": {
    "allowedProviders": ["anthropic", "bedrock"]
  }
}
```

When set, the engine only loads provider configurations for the listed providers. All others are removed from the merged config. This prevents users from adding provider API keys for unauthorized services.

## Tool restrictions

Control which tools are available to the LLM.

### Allow list

When `toolRestrictions.allow` is set, only the listed tools are available. All others are removed.

```json
{
  "enterprise": {
    "toolRestrictions": {
      "allow": ["Read", "Glob", "Grep", "ListMcpResources", "ReadMcpResource"]
    }
  }
}
```

This creates a read-only agent that can search and read files but cannot execute commands or write files.

### Deny list

When `toolRestrictions.deny` is set, the listed tools are removed. All others remain available.

```json
{
  "enterprise": {
    "toolRestrictions": {
      "deny": ["Bash", "Write", "Edit"]
    }
  }
}
```

If both `allow` and `deny` are set, `allow` takes precedence. A tool must be on the allow list and not on the deny list to be available.

## MCP server governance

Control which MCP (Model Context Protocol) servers can be used.

### Allowlist

When `mcpAllowlist` is set, only the listed MCP server names are permitted. Any MCP server configured in user or project config that is not on this list is removed from the merged config.

```json
{
  "enterprise": {
    "mcpAllowlist": ["filesystem", "github", "internal-docs"]
  }
}
```

### Denylist

When `mcpDenylist` is set, the listed MCP server names are blocked. All other servers are permitted.

```json
{
  "enterprise": {
    "mcpDenylist": ["shell-exec", "untrusted-remote"]
  }
}
```

MCP server names are matched against the keys in the `mcpServers` configuration map. See [MCP enterprise controls](../mcp/enterprise-controls.md) for details.

## Required hooks

Enforce that specific hooks are always active. This is useful for compliance hooks that must run on every session (logging, policy enforcement, content filtering).

```json
{
  "enterprise": {
    "requiredHooks": [
      {
        "hook": "tool_call",
        "handler": "compliance-gate"
      },
      {
        "hook": "session_start",
        "handler": "audit-logger"
      }
    ]
  }
}
```

Required hooks are prepended to the handler chain for their respective hook points. They run before any extension-registered handlers. Extensions cannot deregister required hooks.

The handler implementations must be provided by an extension that is installed and active. If a required hook's handler is not found at session start, the session fails to start with an error identifying the missing handler.

## Plan-mode shell access

Plan mode is read-only except for one seam: `limits.planModeAllowedBashCommands` names the Bash command prefixes a planning session may run. Because it is the only way a plan-mode session reaches a shell, it is worth setting explicitly rather than leaving to lower layers.

```json
{
  "enterprise": {
    "limits": {
      "planModeAllowedBashCommands": ["git log", "git diff", "gh pr view", "ls"]
    }
  }
}
```

The enterprise value is a **ceiling**. The developer's `~/.ion/engine.json`, any `.ion/engine.json` committed into a cloned repository, and the two client-supplied run-time paths (`set_plan_mode` overrides and per-prompt slash-command grants) are all intersected against it. Lower layers can narrow further but never widen.

Three values with distinct meanings:

| Enterprise value | Effect |
|---|---|
| omitted | No policy on this axis. Lower layers compose freely — the correct choice for unmanaged machines. |
| `[]` | No Bash in plan mode, ever. Strips every lower-layer entry. |
| `["git log", ...]` | Only these commands, plus narrower forms of them, survive from any lower layer. |

Note this is independent of `toolRestrictions.deny: ["Bash"]`. Denying the Bash tool outright removes it everywhere, including outside plan mode; the plan-mode allowlist governs only what a *planning* session may run and leaves normal execution untouched. An organisation that wants shell access during implementation but not during planning sets the allowlist, not the tool denial.

Full semantics, including how prefix matching decides what a ceiling entry sanctions, are in [Sealed Configuration → Plan-mode Bash allowlist](sealed-config.md#plan-mode-bash-allowlist).

## Auditing enforcement

When enterprise policy strips something from a merged config, the engine records an enforcement action rather than silently dropping it. This is what lets an administrator confirm a policy is active, and lets a developer discover why their config had no effect.

| Action | Meaning |
|---|---|
| `provider_pruned` | A provider not on `allowedProviders` was removed. |
| `provider_pinned` | An enterprise provider definition replaced a user-layer definition (base URL, auth header, backend). |
| `mcp_pruned` | An MCP server was removed by `mcpAllowlist` / `mcpDenylist`. |
| `plan_mode_bash_pruned` | A plan-mode Bash command was rejected by the enterprise ceiling. Subject is the rejected command. |

Actions are recorded during config merge and drained at serve startup and on each enterprise config reload, then emitted through the telemetry pipeline. With central log collection configured they land alongside the rest of the engine's structured output — see [Central Log Collection](central-log-collection.md) and [Telemetry](telemetry.md).

The recorder is bounded, so a consumer that never drains it keeps the most recent actions rather than growing without limit.

## Combining controls

These controls work together. A typical enterprise deployment might combine several:

```json
{
  "enterprise": {
    "allowedProviders": ["anthropic"],
    "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    "toolRestrictions": {
      "deny": ["Bash"]
    },
    "mcpAllowlist": ["filesystem", "github"],
    "limits": {
      "planModeAllowedBashCommands": ["git log", "git diff", "ls"]
    },
    "permissions": {
      "mode": "ask"
    },
    "sandbox": {
      "required": true,
      "allowDisable": false
    },
    "telemetry": {
      "enabled": true,
      "targets": ["http"],
      "httpEndpoint": "https://siem.corp.example.com/ingest/ion"
    }
  }
}
```

This configuration:

- Restricts to Anthropic models only
- Blocks the Bash tool (no shell access)
- Limits MCP to filesystem and GitHub servers
- Caps plan-mode shell access to three read-only commands
- Requires user approval for all tool invocations
- Enforces sandbox on all sessions
- Ships telemetry to a central SIEM
