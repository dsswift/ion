# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CLUI, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email the maintainer directly or use GitHub's private vulnerability reporting feature.
3. Include a description of the vulnerability, steps to reproduce, and potential impact.

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Security Architecture

CLUI runs entirely on your local machine. Key security properties:

- **No cloud backend** — all Claude Code interaction goes through the local `claude` CLI.
- **No telemetry or analytics** — zero outbound data collection.
- **Permission hook server** binds to `127.0.0.1:19836` only (not exposed to the network).
- **Per-launch secrets** — the hook server uses a random UUID as app secret, regenerated on every launch.
- **Sensitive field masking** — tool inputs containing tokens, passwords, keys, or credentials are masked before display in the renderer.
- **CLAUDECODE env var** is explicitly removed from all spawned subprocesses to prevent credential leakage.
- **Preload isolation** — the renderer has no direct access to Node.js APIs; all IPC goes through a typed `window.clui` bridge.

## Network Surface

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `127.0.0.1:19836` | Local only | Permission hook server (PreToolUse) |
| `raw.githubusercontent.com` | Outbound | Marketplace catalog fetch (optional) |
| `api.github.com` | Outbound | Skill tarball download (optional, pinned SHA) |

No other network connections are made by CLUI itself. The `claude` CLI may make its own connections as part of normal operation.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
