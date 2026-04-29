---
title: engine.json Reference
description: Complete field reference for Ion Engine's engine.json configuration file.
sidebar_position: 2
---

# engine.json Reference

This document covers every field in `engine.json`, used at both the user level (`~/.ion/engine.json`) and the project level (`.ion/engine.json`).

## Required configuration

Ion ships with no default model. Before the engine can run a prompt, you must either set `defaultModel` in `engine.json` or pass `--model` on the command line. You also need credentials for the provider that model maps to (a `*_API_KEY` env var, an entry under `providers.<id>.apiKey`, or no key at all if the provider is local). See [models.json Reference](models.md) for registering custom models and tier aliases.

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `"api"` | Backend mode. `"api"` for direct API calls, `"cli"` for CLI proxy. |
| `defaultModel` | string | `""` | Model identifier used when no `--model` override is passed. Required. The engine errors out if neither this field nor `--model` is set. |
| `logLevel` | string | `""` | Log verbosity. One of `"debug"`, `"info"`, `"warn"`, `"error"`. Empty string uses the engine default. |

## providers

Map of provider name to credentials. Keys are provider identifiers (e.g., `"anthropic"`, `"openai"`, `"groq"`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | `""` | API key. If the value is all uppercase letters and underscores (e.g., `"ANTHROPIC_API_KEY"`), the engine resolves it from the environment variable of that name. |
| `baseURL` | string | `""` | Custom API endpoint. Use this for proxies, gateways, or self-hosted providers. |
| `authHeader` | string | `""` | Custom authorization header name. Overrides the provider's default auth header. |

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    },
    "openai": {
      "apiKey": "sk-proj-...",
      "baseURL": "https://gateway.example.com/v1"
    }
  }
}
```

## limits

Resource limits for agent runs. All fields are optional pointers -- omitting a field means "use the value from a lower config layer."

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTurns` | int (nullable) | unset (unlimited) | Maximum number of LLM turns before the agent stops. Unset or `<= 0` means no cap. |
| `maxBudgetUsd` | float (nullable) | unset (unlimited) | Cost ceiling in USD. The agent stops when estimated spend reaches this value. Unset or `<= 0` means no cap. |

These can also be overridden per-session via CLI flags. See [Limits](limits.md) for details.

```json
{
  "limits": {
    "maxTurns": 100,
    "maxBudgetUsd": 25.0
  }
}
```

## mcpServers

Map of server name to MCP server configuration. Each entry defines a connection to a [Model Context Protocol](https://modelcontextprotocol.io/) server.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | -- | Connection type. `"stdio"` for subprocess, `"sse"` for HTTP SSE. |
| `command` | string | `""` | Executable to run (stdio only). |
| `args` | string[] | `[]` | Arguments passed to the command (stdio only). |
| `url` | string | `""` | Server URL (SSE only). |
| `env` | object | `{}` | Environment variables passed to the subprocess (stdio only). |
| `headers` | object | `{}` | HTTP headers sent with SSE connections. |
| `oauth` | object | `null` | OAuth 2.0 configuration for authenticated MCP servers. |

### MCP OAuth fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `client_id` | string | -- | OAuth client ID. |
| `client_secret` | string | `""` | OAuth client secret (omit for public clients). |
| `auth_url` | string | -- | Authorization endpoint URL. |
| `token_url` | string | -- | Token endpoint URL. |
| `scope` | string | `""` | Space-separated scopes. |
| `redirect_uri` | string | `""` | Redirect URI for the OAuth flow. |
| `use_pkce` | bool | `false` | Enable PKCE (Proof Key for Code Exchange). |

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    },
    "remote-db": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer token-here"
      }
    }
  }
}
```

## permissions

Controls how the engine evaluates tool execution permissions.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | -- | Default decision when no rule matches. `"allow"`, `"ask"`, or `"deny"`. |
| `rules` | array | `[]` | Ordered list of permission rules evaluated top to bottom. |
| `dangerousPatterns` | string[] | `[]` | Regex patterns for commands that should always require approval. |
| `readOnlyPaths` | string[] | `[]` | Path patterns where writes are denied. |

### Permission rule fields

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name to match (e.g., `"Bash"`, `"Write"`). |
| `decision` | string | `"allow"` or `"deny"`. |
| `commandPatterns` | string[] | Regex patterns matched against the command string (Bash tool). |
| `pathPatterns` | string[] | Glob patterns matched against file paths (Read, Write, Edit tools). |

Rules are evaluated in order. The first matching rule wins. If no rule matches, the `mode` default applies.

```json
{
  "permissions": {
    "mode": "ask",
    "rules": [
      {
        "tool": "Bash",
        "decision": "allow",
        "commandPatterns": ["^git (status|log|diff)"]
      },
      {
        "tool": "Bash",
        "decision": "deny",
        "commandPatterns": ["rm -rf /"]
      },
      {
        "tool": "Write",
        "decision": "deny",
        "pathPatterns": ["/etc/**"]
      }
    ],
    "dangerousPatterns": ["curl.*\\| ?sh", "eval\\("],
    "readOnlyPaths": ["/usr/**", "/System/**"]
  }
}
```

## auth

Authentication and credential management.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `oauth` | object | `{}` | Map of provider ID to OAuth configuration. |
| `secureStore` | object | `null` | Credential storage backend configuration. |
| `cacheTtlMs` | int64 | `0` | How long to cache resolved credentials (milliseconds). |
| `refreshThresholdMs` | int64 | `0` | Refresh tokens this many milliseconds before expiry. |

### OAuth provider fields

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | string | OAuth client ID. |
| `authorizationUrl` | string | Authorization endpoint. |
| `tokenUrl` | string | Token endpoint. |
| `scopes` | string[] | Requested scopes. |
| `usePkce` | bool | Enable PKCE. |
| `redirectUri` | string | Redirect URI. |

### Secure store fields

| Field | Type | Description |
|-------|------|-------------|
| `backend` | string | Storage backend: `"keychain"`, `"file"`, or others. |
| `serviceName` | string | Service name for keychain storage. |
| `filePath` | string | Path for file-based credential storage. |

## network

Network transport configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `proxy` | object | `null` | HTTP proxy settings. |
| `customCaCerts` | string[] | `[]` | Paths to PEM-encoded CA certificate files. |
| `rejectUnauthorized` | bool (nullable) | `null` | Set to `false` to disable TLS certificate validation. Use only for development. |

### Proxy fields

| Field | Type | Description |
|-------|------|-------------|
| `httpProxy` | string | HTTP proxy URL. |
| `httpsProxy` | string | HTTPS proxy URL. |
| `noProxy` | string | Comma-separated list of hosts that bypass the proxy. |

```json
{
  "network": {
    "proxy": {
      "httpsProxy": "http://proxy.corp.example.com:8080",
      "noProxy": "localhost,127.0.0.1,.internal.example.com"
    },
    "customCaCerts": ["/etc/ssl/certs/corp-ca.pem"]
  }
}
```

## telemetry

Telemetry collection and export.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Master switch for telemetry. |
| `targets` | string[] | `[]` | Export targets: `"http"`, `"file"`, `"otel"`. |
| `httpEndpoint` | string | `""` | HTTP endpoint for telemetry export. |
| `httpHeaders` | object | `{}` | Headers sent with HTTP telemetry requests. |
| `filePath` | string | `""` | Path for file-based telemetry output. |
| `privacyLevel` | string | `""` | Controls what data is collected. |
| `batchSize` | int | `0` | Number of events per export batch. |
| `flushIntervalMs` | int64 | `0` | How often to flush batched events (milliseconds). |
| `otel` | object | `null` | OpenTelemetry export configuration. |

### OpenTelemetry fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool | Enable OTLP export. |
| `endpoint` | string | OTLP collector endpoint. |
| `protocol` | string | Export protocol (e.g., `"grpc"`, `"http/protobuf"`). |
| `headers` | object | Headers sent to the collector. |
| `serviceName` | string | Service name reported in traces. |
| `resourceAttributes` | object | Additional OTLP resource attributes. |

```json
{
  "telemetry": {
    "enabled": true,
    "targets": ["http"],
    "httpEndpoint": "https://telemetry.example.com/v1/events",
    "httpHeaders": {
      "Authorization": "Bearer ingest-token"
    },
    "batchSize": 50,
    "flushIntervalMs": 10000
  }
}
```

## compaction

Context window compaction controls how the engine manages conversation length.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | string | `""` | Compaction strategy. |
| `keepTurns` | int | `0` | Number of recent turns to preserve during compaction. |
| `threshold` | float | `0` | Context utilization threshold that triggers compaction (0.0 to 1.0). |

## security

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `redactSecrets` | bool | `false` | When enabled, the engine scans tool output for secrets and redacts them before returning to the model. |

## relay

WebSocket relay connection for mobile remote access.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | `""` | WebSocket relay URL (e.g., `wss://relay.example.com`). |
| `apiKey` | string | `""` | Bearer token for relay authentication. |
| `channelId` | string | `""` | 32-character hex channel identifier. |

## featureFlags

Feature flag source configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `source` | string | `""` | Flag source type: `"static"`, `"file"`, or `"http"`. |
| `path` | string | `""` | File path (for `"file"` source). |
| `url` | string | `""` | HTTP endpoint (for `"http"` source). |
| `interval` | int64 | `0` | Poll interval in milliseconds (for `"http"` source). |
| `static` | object | `{}` | Static flag values (for `"static"` source). |

```json
{
  "featureFlags": {
    "source": "static",
    "static": {
      "new-compaction": true,
      "experimental-tools": false
    }
  }
}
```

## Full example

A multi-provider configuration mixing a local Ollama model with a hosted OpenAI fallback. Pick whichever model fits the task and let the engine route to the right provider.

```json
{
  "backend": "api",
  "defaultModel": "qwen2.5:14b",
  "logLevel": "info",
  "providers": {
    "ollama": {},
    "openai": {
      "apiKey": "OPENAI_API_KEY"
    }
  },
  "limits": {
    "maxTurns": 100,
    "maxBudgetUsd": 25.0
  },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  },
  "permissions": {
    "mode": "ask",
    "rules": [
      {
        "tool": "Bash",
        "decision": "allow",
        "commandPatterns": ["^git "]
      }
    ]
  },
  "security": {
    "redactSecrets": true
  },
  "telemetry": {
    "enabled": false
  }
}
```

## See also

* [models.json Reference](models.md) for registering custom models and tier aliases.
* [Provider Setup](../providers/index.md) for the catalog of supported providers and their environment variables.
