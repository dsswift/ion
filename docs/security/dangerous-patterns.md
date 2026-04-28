---
title: Dangerous Patterns
description: Built-in detection for risky shell commands, with customizable pattern lists.
sidebar_position: 3
---

# Dangerous Patterns

The engine maintains a list of regex patterns that match risky shell commands. When a Bash tool invocation matches one of these patterns, the engine flags it before execution. What happens next depends on the permission mode:

- **allow mode**: The command runs, but the match is logged in the audit trail.
- **ask mode**: The user is prompted with the matched pattern and reason before the command runs.
- **deny mode**: The command is blocked.

## Default patterns

The engine ships with 35+ patterns covering common categories of risky operations:

| Category | Examples |
|----------|----------|
| Destructive file operations | `rm -rf /`, `rm -rf ~`, `rm -rf *` |
| Privilege escalation | `chmod 777`, `chmod -R 777`, `sudo` |
| Network exfiltration | `curl \| sh`, `wget \| bash`, `curl` piped to execution |
| System modification | `mkfs`, `dd if=`, `fdisk` |
| Credential exposure | `cat ~/.ssh/*`, `cat /etc/shadow` |
| Package execution | `npm exec`, `npx` with untrusted packages |
| History/config tampering | `history -c`, editing `.bashrc` or `.zshrc` |

These patterns are compiled into the engine binary. They apply automatically when the permission system is active.

## Customizing patterns

Add patterns via the `dangerousPatterns` field in your permission policy:

```json
{
  "permissions": {
    "mode": "ask",
    "dangerousPatterns": [
      "docker\\s+run.*--privileged",
      "kubectl\\s+delete",
      "terraform\\s+destroy"
    ]
  }
}
```

Custom patterns are appended to the built-in list. You cannot remove built-in patterns, only add to them.

### Pattern format

Patterns are Go regular expressions (RE2 syntax). They are matched against the full command string passed to the Bash tool. Patterns are case-sensitive by default; use `(?i)` for case-insensitive matching.

```json
{
  "dangerousPatterns": [
    "(?i)drop\\s+database",
    "(?i)truncate\\s+table"
  ]
}
```

## Enterprise patterns

Enterprise config can add additional dangerous patterns that apply organization-wide and cannot be removed by lower config layers:

```json
{
  "enterprise": {
    "sandbox": {
      "additionalDangerousPatterns": [
        {
          "pattern": "kubectl\\s+apply.*--namespace=production",
          "description": "Production Kubernetes deployments require CI/CD"
        }
      ]
    }
  }
}
```

Enterprise patterns are prepended to the pattern list, ensuring they are evaluated first. See [Enterprise compliance](../enterprise/compliance.md) for more on enterprise security controls.

## Interaction with rules

Dangerous pattern detection and permission rules are separate systems that work together:

1. The engine checks permission rules first (first-match-wins).
2. If a rule explicitly allows the command, it runs.
3. If no rule matches and the mode is `ask` or `deny`, the engine then checks dangerous patterns.
4. A dangerous pattern match in `ask` mode triggers a user prompt with the pattern description.

This means an explicit `allow` rule overrides dangerous pattern detection. Design your rules carefully if you have both.
