# Security Policy

## Security Architecture

Ion Desktop runs entirely on your local machine. It is a UI layer that connects to the Ion Engine daemon over a Unix socket. All agent execution, tool calls, permission decisions, and sandboxing happen inside the engine. The desktop app does not evaluate or enforce security policy itself.

Key security properties:

- **No cloud backend.** The engine runs locally. Desktop connects to it over `~/.ion/engine.sock`. No remote services are involved in agent execution.
- **No telemetry or analytics.** Zero outbound data collection.
- **Engine-managed execution.** Tool execution happens inside Ion Engine. Sandboxing and permission policies are configurable by the harness engineer via engine config and extensions. Desktop surfaces permission requests in the UI but does not make policy decisions.
- **Preload isolation.** The renderer has no direct access to Node.js APIs. All IPC goes through a typed `window.ion` bridge.
- **Sensitive field masking.** Tool inputs containing tokens, passwords, keys, or credentials are masked before display in the renderer.

## Network Surface

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `~/.ion/engine.sock` | Local only | Unix socket connection to Ion Engine (agent sessions, events) |
| `raw.githubusercontent.com` | Outbound | Marketplace catalog fetch (optional) |
| `api.github.com` | Outbound | Skill tarball download (optional, pinned SHA) |

No other network connections are made by Ion Desktop. The engine may make outbound connections to LLM providers as part of normal operation. See the [engine documentation](../engine/README.md) for details.

## Reporting Vulnerabilities

Report security issues through [GitHub's private vulnerability reporting](https://github.com/dsswift/ion/security/advisories) on this repository.
