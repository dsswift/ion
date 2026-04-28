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
- Requires user approval for all tool invocations
- Enforces sandbox on all sessions
- Ships telemetry to a central SIEM
