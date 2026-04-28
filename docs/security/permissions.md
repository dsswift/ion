---
title: Permissions
description: Permission modes, rules, evaluation order, and dangerous pattern integration.
sidebar_position: 2
---

# Permissions

The permission system controls which tools the LLM can invoke. It operates in one of three modes and supports fine-grained rules for per-tool, per-command, and per-path decisions.

## Permission modes

The `mode` field sets the baseline behavior when no rule matches a tool invocation.

| Mode | Behavior |
|------|----------|
| `allow` | All tool calls pass. No prompting. This is the default. |
| `ask` | Unknown tool calls prompt the user for approval via the client. |
| `deny` | All tool calls are blocked unless an explicit rule allows them. |

## Permission policy

The full policy structure:

```json
{
  "permissions": {
    "mode": "ask",
    "rules": [
      {
        "tool": "Read",
        "decision": "allow"
      },
      {
        "tool": "Bash",
        "decision": "allow",
        "commandPatterns": ["^git\\s"]
      },
      {
        "tool": "Bash",
        "decision": "deny",
        "commandPatterns": ["rm\\s+-rf"]
      },
      {
        "tool": "Write",
        "decision": "deny",
        "pathPatterns": ["/etc/*", "/usr/*"]
      }
    ],
    "dangerousPatterns": [],
    "readOnlyPaths": []
  }
}
```

## Rules

Each rule targets a specific tool and declares a decision (`allow` or `deny`). Rules can optionally narrow scope with command or path patterns.

| Field | Type | Description |
|-------|------|-------------|
| `tool` | `string` | Tool name to match (e.g., `"Bash"`, `"Write"`, `"Read"`) |
| `decision` | `string` | `"allow"` or `"deny"` |
| `commandPatterns` | `string[]` | Regex patterns matched against the command string. Applies to `Bash` tool invocations. |
| `pathPatterns` | `string[]` | Glob patterns matched against file paths. Applies to `Read`, `Write`, and `Edit` tools. |

## Evaluation order

Rules are evaluated in array order. The first matching rule wins.

1. The engine receives a tool call from the LLM.
2. It walks the `rules` array from index 0 to N.
3. For each rule, it checks: does the tool name match? If so, do the optional patterns match the input?
4. The first rule that matches determines the decision.
5. If no rule matches, the engine falls back to the `mode` default.

This means rule ordering matters. Place specific rules before general ones.

### Example: allow git, deny everything else in Bash

```json
{
  "permissions": {
    "mode": "deny",
    "rules": [
      {
        "tool": "Read",
        "decision": "allow"
      },
      {
        "tool": "Bash",
        "decision": "allow",
        "commandPatterns": ["^git\\s"]
      }
    ]
  }
}
```

The LLM can read any file and run git commands. All other tools and Bash commands are blocked.

## Read-only paths

The `readOnlyPaths` array contains glob patterns for paths that should be readable but not writable. When a `Write` or `Edit` tool call targets a path matching any pattern in this list, the engine blocks the call regardless of rules.

```json
{
  "permissions": {
    "mode": "allow",
    "readOnlyPaths": [
      "/etc/**",
      "/usr/**",
      "node_modules/**"
    ]
  }
}
```

## Dangerous patterns

The `dangerousPatterns` array supplements the engine's built-in list of risky command patterns. When a Bash command matches a dangerous pattern, it is flagged for additional scrutiny (in `ask` mode, the user is prompted; in `deny` mode, it is blocked). See [Dangerous patterns](dangerous-patterns.md) for the full default list and customization options.

## Enterprise enforcement

When enterprise config sets a permission policy, it seals the configuration:

- If enterprise sets `mode` to `"ask"`, no lower layer can change it to `"allow"`.
- Enterprise rules are prepended to the rule list, so they evaluate first.
- Enterprise `dangerousPatterns` and `readOnlyPaths` are merged (union) with lower layers.

See [Enterprise sealed config](../enterprise/sealed-config.md) for sealing semantics.

## Audit integration

Every permission decision is logged as an audit entry, regardless of the outcome. See [Audit logging](audit.md) for the entry format and storage options.
