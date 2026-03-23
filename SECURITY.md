# Security Policy

## Security Architecture

CODA runs entirely on your local machine. Key security properties:

- **No cloud backend** — all Claude Code interaction goes through the local `claude` CLI.
- **No telemetry or analytics** — zero outbound data collection.
- **Permission hook server** binds to `127.0.0.1:19836` only (not exposed to the network).
- **Per-launch secrets** — the hook server uses a random UUID as app secret, regenerated on every launch.
- **Sensitive field masking** — tool inputs containing tokens, passwords, keys, or credentials are masked before display in the renderer.
- **CLAUDECODE env var** is explicitly removed from all spawned subprocesses to prevent credential leakage.
- **Preload isolation** — the renderer has no direct access to Node.js APIs; all IPC goes through a typed `window.coda` bridge.

## Network Surface

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `127.0.0.1:19836` | Local only | Permission hook server (PreToolUse) |
| `raw.githubusercontent.com` | Outbound | Marketplace catalog fetch (optional) |
| `api.github.com` | Outbound | Skill tarball download (optional, pinned SHA) |

No other network connections are made by CODA itself. The `claude` CLI may make its own connections as part of normal operation.
