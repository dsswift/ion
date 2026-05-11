---
title: Environment Variables
description: Environment variables recognized by the Ion Engine.
sidebar_position: 4
---

# Environment Variables

Ion Engine reads several environment variables for provider credentials and system configuration.

## Provider API keys

The engine automatically checks for these environment variables during config loading, even if they are not referenced in `engine.json`:

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic | API key for Claude models. |
| `OPENAI_API_KEY` | OpenAI | API key for GPT models. |

If a provider entry exists in `engine.json` with an explicit `apiKey` value, the environment variable is not used for that provider. Environment variables serve as a fallback when no key is configured in the file.

### Env var resolution in config

Any provider's `apiKey` field in `engine.json` supports environment variable resolution. If the value is all uppercase letters and underscores, the engine treats it as an environment variable name and resolves the actual key at runtime:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    },
    "openai": {
      "apiKey": "MY_CUSTOM_OPENAI_KEY"
    }
  }
}
```

In this example, the engine reads `$ANTHROPIC_API_KEY` and `$MY_CUSTOM_OPENAI_KEY` from the environment. This keeps secrets out of config files while still letting you specify which env var to use.

A literal API key (mixed case, containing hyphens, etc.) is used as-is:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-api03-actual-key-here"
    }
  }
}
```

## System configuration

| Variable | Description |
|----------|-------------|
| `ION_ENTERPRISE_CONFIG` | Path to a JSON file containing enterprise configuration. Checked before any platform-specific enterprise source (MDM plist, registry, /etc). Works on all operating systems. |

### Enterprise config path

`ION_ENTERPRISE_CONFIG` is the highest-priority enterprise config source. When set, the engine reads the JSON file at the specified path and uses it as the enterprise layer. Platform-specific sources (macOS managed preferences, Linux `/etc/ion/`, Windows registry) are not checked if this variable is set and points to a valid file.

```bash
export ION_ENTERPRISE_CONFIG="/opt/company/ion-policy.json"
```

This is useful for:

- Testing enterprise policies during development.
- Environments where MDM is not available.
- Containerized deployments where filesystem paths are more practical than platform MDM.

## MCP server environment

MCP servers configured with `type: "stdio"` can receive custom environment variables via the `env` field in their config entry. These are set on the subprocess, not on the engine itself:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "my-mcp-server",
      "env": {
        "DATABASE_URL": "postgres://localhost/mydb",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

These variables are only visible to the MCP server subprocess and do not affect the engine process.

## Relay server

The relay server (a separate Go binary, not part of the engine) reads its configuration from environment variables. These are documented here for convenience; the relay is deployed independently.

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_API_KEY` | -- (required) | Hex secret for Bearer authentication. Generate with `openssl rand -hex 32`. |
| `RELAY_PORT` | `8443` | Listen port. |
| `RELAY_WRITE_TIMEOUT_MS` | `10000` | Write timeout in milliseconds when forwarding messages to a peer. |
| `RELAY_PING_INTERVAL_S` | `30` | Interval in seconds between WebSocket keepalive pings. |
| `RELAY_PING_TIMEOUT_S` | `10` | Maximum seconds to wait for a pong response before closing the connection. |
| `RELAY_MAX_MESSAGE_SIZE` | `1048576` (1 MB) | Maximum WebSocket message size in bytes. |
| `APNS_KEY_PATH` | -- | Path to APNs `.p8` key file for iOS push notifications. |
| `APNS_KEY_ID` | -- | APNs key ID from Apple Developer portal. |
| `APNS_TEAM_ID` | -- | Apple Developer team ID. |

See [Relay Deployment](../deployment/relay.md) for full deployment instructions.
