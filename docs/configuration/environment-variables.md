---
title: Environment Variables
description: Environment variables recognized by the Ion Engine.
sidebar_position: 5
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
| `ION_DATA_DIR` | The engine's data root. When set, used verbatim as the base for every engine-owned path — conversations, session bindings, `install_id`, `engine.json`, `settings.json`, the worktree registry, logs, the plugin cache, MCP client and token stores, skills, and plan directories. When unset, the conventional `<home>/.ion` path is used. Lets multiple engine instances share one machine (or a container) without colliding on `~/.ion`. The Ion Studio Server reads and writes `<ION_DATA_DIR>/server.json`, `server.jsonl`, and its other server-owned files from the SAME root — an engine and server forming one Environment must share it. |
| `ION_HOST_NAME` | The host name the engine and the Ion Studio Server report in log lines (`host`), telemetry and egress (`host.name`), finished-conversation pushes, and iOS log attribution. Unset uses the OS hostname. A container's hostname is its pod name, new on every restart, so a deployment sets this to a name that outlives the pod (its public DNS name) and every restart stays one host in the Fleet dashboards. Identity only: network addresses, discovery, and pairing links still use the OS hostname. Set the same value on the engine and the server. |
| `ION_SOCKET_PATH` | Overrides the engine's Unix-socket (or Windows loopback) address the server and CLI dial. Unset resolves to `<ION_DATA_DIR>/engine.sock`. Set this to point the socket at a separate volume from the rest of `ION_DATA_DIR` — e.g. a Kubernetes pod's shared `emptyDir` — so socket churn never touches the durable PVC. |
| `ION_STUDIO_PROFILE` | Names the kind of install a Studio Server is part of, which only moves its *defaults*. `personal` is what a desktop sets for its own built-in server: one person's machine, so `tenancy.mode` defaults to `shared` and `admin` joins the default pairing scopes -- a second device that pairs with it acts as the owner and can run the Environment page. Any other value, or unset, keeps the `isolated` defaults. A value written in `server.json` always wins, and the shared default steps back to `isolated` when the engine partitions storage per principal. The headless installer does not use this: it writes the same choices into `server.json`. See [Server JSON reference](server-json.md#tenancy). |
| `ION_SERVER_RELAY_PSK` | The Ion Studio Server's `secretstore:relay-psk` resolution source (`server.json`'s `relays[].psk` field, manifest C5) when running as a container or pod with no local Tier-2 keyfile store. See [Ion Studio Server](../deployment/studio-server.md). |

### Data directory

`ION_DATA_DIR` is resolved once by `utils.IonDir()`, the engine's single data-root resolver. Every engine-owned path derives from it — there is no second source of truth for where the engine keeps its files.

```bash
ION_DATA_DIR=/data ./ion serve
```

This is useful for:

- Running a second engine instance on one machine without colliding with `~/.ion`.
- Containerized deployments (the engine's `Dockerfile` sets `ION_DATA_DIR=/data`).
- Test harnesses that need an isolated, disposable data root.

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
| `RELAY_OIDC_ISSUERS` | -- | JSON array of further OIDC issuers the relay accepts alongside `RELAY_OIDC_ISSUER`, each `{issuer, audience, requiredScope}` with its own audience and scope. For one relay serving a person signed in to more than one identity tenant. See [Several tenants on one relay](../deployment/relay-oidc.md#several-tenants-on-one-relay). |
| `RELAY_TRUSTED_ISSUERS` | -- | Comma-separated OIDC issuer URLs the relay trusts for server-announced trust (manifest C7): a per-channel issuer override an Ion Studio Server names in its `relay_announce` frame. See [Server-Announced Trust](../deployment/relay-oidc.md#server-announced-trust). |
| `RELAY_STATE_DIR` | -- | Directory for persisted channel-owner bindings. Memory-only when unset (bindings do not survive a relay restart). The relay stores no push addresses; the server sends one with each push. |
| `APNS_KEY_PATH` | -- | Path to APNs `.p8` key file for iOS push notifications. |
| `APNS_KEY` | -- | The `.p8` key's PEM text itself, instead of a file. Set this or `APNS_KEY_PATH`, never both. |
| `APNS_KEY_ID` | -- | APNs key ID from Apple Developer portal. |
| `APNS_TEAM_ID` | -- | Apple Developer team ID. |
| `APNS_TOPIC` | -- | The iOS app's bundle identifier, sent as the `apns-topic` header. Required when the three APNs variables above are set. |
| `APNS_PRODUCTION` | -- | Set to `1` to use Apple's production APNs endpoint for a push that arrives without its token's environment. Default uses the sandbox endpoint. A push that carries one (`pushEnv`, sent by the server) always goes to that environment. |

See [Relay Deployment](../deployment/relay.md) for full deployment instructions.
