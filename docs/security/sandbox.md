---
title: Sandbox
description: OS-level process isolation for tool execution using Seatbelt (macOS) and bubblewrap (Linux).
sidebar_position: 4
---

# Sandbox

The sandbox wraps tool execution in OS-level process isolation. When enabled, Bash tool invocations run inside a restricted sandbox that limits filesystem access, network access, and system calls.

Sandboxing is disabled by default. Enable it in your configuration or enforce it via enterprise policy.

## Platform support

| Platform | Technology | Requirement |
|----------|-----------|-------------|
| macOS | Seatbelt (`sandbox-exec`) | Built into macOS. No installation needed. |
| Linux | bubblewrap (`bwrap`) | Must be installed. Available in most package managers. |
| Windows | Not supported | No sandbox implementation. |

## Enabling the sandbox

Add the sandbox configuration to your engine config:

```json
{
  "sandbox": {
    "enabled": true
  }
}
```

This enables the default sandbox profile for the current platform.

### macOS (Seatbelt)

On macOS, the engine generates a Seatbelt profile that:

- Allows read access to the project directory and common tool paths
- Allows write access to the project directory and temp directories
- Denies network access by default
- Denies access to user home directory files outside the project

The Seatbelt profile is passed to `sandbox-exec` which wraps the tool subprocess.

### Linux (bubblewrap)

On Linux, the engine uses bubblewrap to create a minimal container:

- Binds the project directory read-write
- Binds `/usr`, `/bin`, `/lib` read-only
- Mounts a private `/tmp`
- Drops all capabilities
- Isolates the network namespace (no network by default)

bubblewrap must be installed and accessible in `PATH`. Install it via your package manager:

```bash
# Debian/Ubuntu
apt install bubblewrap

# Fedora/RHEL
dnf install bubblewrap

# Arch
pacman -S bubblewrap
```

## Enterprise enforcement

Enterprise config can require sandboxing and prevent users from disabling it:

```json
{
  "enterprise": {
    "sandbox": {
      "required": true,
      "allowDisable": false,
      "additionalDenyPaths": [
        "/var/secrets",
        "/opt/internal"
      ],
      "additionalDangerousPatterns": [
        {
          "pattern": "mount\\s+",
          "reason": "Mount operations blocked by policy"
        }
      ]
    }
  }
}
```

### Enterprise sandbox fields

| Field | Type | Description |
|-------|------|-------------|
| `required` | `bool` | When `true`, all sessions must run with sandbox enabled. Sessions on platforms without sandbox support will fail to start. |
| `allowDisable` | `bool` | When `false`, user and project configs cannot set `sandbox.enabled = false`. |
| `additionalDenyPaths` | `string[]` | Extra paths to deny access to, merged with the default deny list. |
| `additionalDangerousPatterns` | `DangerousPattern[]` | Command patterns the engine refuses before a Bash command runs. Each entry has `pattern` (Go RE2 regex) and `reason` (the text returned when a command is refused). |

### Dangerous patterns do not need the sandbox

`additionalDangerousPatterns` is enforced on every session under the policy, on every platform, whether or not the sandbox is on. A policy can block specific commands without setting `required`.

- With the sandbox off, a Bash command is checked against the configured patterns only.
- With the sandbox on, a Bash command is checked against the configured patterns and the built-in sandbox patterns. Configured patterns add to the built-in set and never replace it.
- A refused command returns `Command blocked by policy: <reason>` as the tool result and fires the `permission_denied` hook.
- A pattern that does not compile cannot be enforced. The engine logs it at error level when it loads the config (`"msg":"invalid enterprise dangerous command pattern: not enforced"`, with the pattern and the compile error) and enforces the rest.

## Limitations

- Sandbox only wraps Bash tool execution. Other tools (Read, Write, Edit) operate within the engine process and are controlled by the permission system, not the sandbox.
- macOS Seatbelt profiles are coarse-grained. Fine-tuning requires custom profile authoring, which the engine does not currently support.
- bubblewrap on Linux requires unprivileged user namespaces. Some hardened kernel configurations disable this. Check `sysctl kernel.unprivileged_userns_clone`.
- Network isolation may break tools that need external access (package managers, API calls). Consider your tool requirements before enabling network restrictions.
