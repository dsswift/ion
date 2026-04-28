---
title: MCP Enterprise Controls
description: Allowlists, denylists, and enterprise governance for MCP server connections.
sidebar_position: 4
---

# MCP Enterprise Controls

Enterprise config can restrict which MCP servers are permitted. This prevents users from connecting to unauthorized external services or running untrusted MCP server code.

## Allowlist

When `mcpAllowlist` is set, only the listed MCP server names are permitted. Any MCP server configured in user or project config that is not on this list is removed from the merged config before the session starts.

```json
{
  "enterprise": {
    "mcpAllowlist": ["filesystem", "github", "internal-docs"]
  }
}
```

With this config, a user who adds a `shell-exec` MCP server to their personal config will find it silently removed at session start. Only `filesystem`, `github`, and `internal-docs` servers are allowed.

### How names are matched

Server names are matched against the keys in the `mcpServers` config map. The match is exact and case-sensitive.

User config:

```json
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "..." },
    "github": { "type": "stdio", "command": "..." },
    "untrusted-tool": { "type": "sse", "url": "..." }
  }
}
```

Enterprise allowlist: `["filesystem", "github"]`

Result: `filesystem` and `github` are kept. `untrusted-tool` is removed.

## Denylist

When `mcpDenylist` is set, the listed MCP server names are blocked. All other servers are permitted.

```json
{
  "enterprise": {
    "mcpDenylist": ["shell-exec", "code-runner", "untrusted-remote"]
  }
}
```

Use a denylist when you want to block specific known-risky servers while allowing everything else.

## Allowlist vs denylist

| Approach | When to use |
|----------|-------------|
| Allowlist only | High-security environments. Only approved servers can run. Users cannot add new servers without IT approval. |
| Denylist only | Permissive environments. Most servers are fine, but a few known-bad ones should be blocked. |
| Both | The allowlist takes precedence. A server must be on the allowlist and not on the denylist to be permitted. |

In practice, most enterprise deployments use one or the other, not both. An allowlist provides stronger guarantees because it blocks unknown servers by default.

## Sealing behavior

Enterprise MCP controls are sealed:

- **Allowlist entries cannot be expanded** by lower config layers. If enterprise allows `["filesystem", "github"]`, user config cannot add a third server name to the allowlist.
- **Denylist entries cannot be removed** by lower config layers. If enterprise denies `["shell-exec"]`, user config cannot un-deny it.
- **Server configurations** for allowed servers can still be customized by lower layers. Enterprise controls which servers are permitted, not how they are configured.

## Interaction with permissions

MCP tool calls go through the engine's permission system. Even if an MCP server is on the allowlist, its tools are still subject to permission rules:

- In `ask` mode, MCP tool calls prompt the user for approval.
- In `deny` mode, MCP tool calls are blocked unless an explicit rule allows them.
- Dangerous pattern detection applies to any MCP tool that executes commands.

Enterprise can combine MCP controls with permission rules for layered governance:

```json
{
  "enterprise": {
    "mcpAllowlist": ["filesystem", "github"],
    "permissions": {
      "mode": "ask",
      "rules": [
        {
          "tool": "filesystem__read_file",
          "decision": "allow"
        }
      ]
    }
  }
}
```

This allows the filesystem server's `read_file` tool to run without prompting, while all other MCP tool calls require user approval.

## Logging

MCP governance decisions are logged:

- Servers removed by allowlist/denylist filtering are logged at startup with the reason.
- MCP tool invocations are logged through the standard audit system, including the server name and tool name.

See [Audit logging](../security/audit.md) for audit entry format.
