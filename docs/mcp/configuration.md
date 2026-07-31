---
title: MCP Configuration
description: MCP server configuration reference -- stdio, SSE, environment variables, OAuth, and examples.
sidebar_position: 2
---

# MCP Configuration

MCP servers are configured in the `mcpServers` map of your engine config. Each key is the server name (used for display and enterprise governance). Each value is an `McpServerConfig` object.

## Server config reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | Transport type: `"stdio"`, `"http"`, `"sse"`, or `"ws"` (alias: `"websocket"`) |
| `command` | `string` | stdio only | Command to execute |
| `args` | `string[]` | No | Command arguments |
| `url` | `string` | network transports | Remote server URL (`http`, `sse`, `ws`) |
| `env` | `map[string]string` | No | Environment variables passed to the server process (stdio) or included in requests (network transports) |
| `headers` | `map[string]string` | No | Static HTTP headers for network transports |
| `oauth` | `McpOAuthConfig` | No | Explicit OAuth 2.0 client configuration. Omit it for a server that supports discovery — see [OAuth and authorization](#oauth-and-authorization). |
| `timeoutSeconds` | `int` | No | Per-server tool-call timeout. Unset uses the engine default. |
| `forwardUserToken` | `bool` | No | Stamp the signed-in operator's OIDC token on every request to this server. Opt-in per server; see [Operator token forwarding](#operator-token-forwarding). |
| `userTokenScope` | `string` | No | Downstream resource scope the forwarded token is minted for. Only meaningful with `forwardUserToken`. |
| `userTokenAudience` | `string` | No | Explicit audience/resource for the forwarded token, for identity providers that bind grants to one (Auth0, RFC 8707) instead of encoding the resource in the scope. Only meaningful with `forwardUserToken`. |

The transport is what decides whether `command` or `url` applies. `stdio` spawns
a subprocess; `http`, `sse`, and `ws` connect to a remote endpoint. `http` is
StreamableHTTP, the current MCP network transport, and is the right default for
a new remote server; `sse` is the older protocol and is selected explicitly.

## stdio transport

The engine spawns the MCP server as a child process. Communication happens over the process's stdin and stdout using the MCP wire protocol.

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"]
    },
    "database": {
      "type": "stdio",
      "command": "/usr/local/bin/mcp-postgres",
      "args": ["--connection", "postgres://localhost:5432/mydb"],
      "env": {
        "PGPASSWORD": "secret"
      }
    }
  }
}
```

### Command resolution

The `command` field is resolved using the system PATH. For Node.js-based MCP servers, `npx` is the typical launcher. For compiled servers, use an absolute path or ensure the binary is in PATH.

### Environment variables

The `env` map sets environment variables on the spawned process. These are merged with the engine's environment. Use this for credentials, connection strings, and server-specific configuration.

Environment variables in `env` are not passed to the LLM or logged in telemetry.

## Network transports (http, sse, ws)

The engine connects to a remote MCP server over HTTP. `http` (StreamableHTTP)
posts requests and reads responses over the same endpoint and is the current
transport; `sse` uses Server-Sent Events for the server-to-client channel with
HTTP POST for client-to-server messages; `ws` speaks MCP over a WebSocket.

```json
{
  "mcpServers": {
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Prefer `http` for a token-forwarded server: WebSocket headers apply once at dial
time, so refreshing a forwarded token requires a reconnect.

### Headers

Custom headers are included on every request the transport makes — the SSE
connection request and its subsequent POSTs, each StreamableHTTP request, or the
WebSocket upgrade. Use them for API keys, pre-shared bearer tokens, and routing
metadata. A server using OAuth needs none of them.

### Network considerations

Network transports use long-lived HTTP connections. They are subject to:

- Enterprise proxy settings (see [Network configuration](../enterprise/network.md))
- Custom CA certificate configuration
- TLS verification settings

Ensure your proxy and firewall configuration allows long-lived HTTP connections to the MCP server endpoint. Discovery, registration, and token requests route through the same configured transport, so an enterprise proxy or custom CA applies to them too.

## OAuth and authorization

Most remote MCP servers require authorization. Ion handles it end to end, and
the zero-config path is the normal one:

```bash
ion mcp add mobbin https://api.mobbin.com/mcp
ion mcp login mobbin
```

`ion mcp login` opens your browser, you sign in with the provider, and the
engine stores the resulting grant. Nothing goes in `engine.json` — no
`client_id`, no endpoints.

### What the engine does

1. **Protected-resource discovery (RFC 9728).** The engine fetches
   `/.well-known/oauth-protected-resource` from the MCP endpoint to learn which
   authorization server issues tokens for it.
2. **Authorization-server discovery (RFC 8414).** It fetches that server's
   `/.well-known/oauth-authorization-server`, falling back to
   `/.well-known/openid-configuration`, for the authorization, token, and
   registration endpoints.
3. **Dynamic client registration (RFC 7591).** If the server supports it, the
   engine registers itself as a public client and stores the issued `client_id`
   in `~/.ion/mcp-clients.json`. This is why no `client_id` needs configuring:
   for these servers, none exists until registration runs.
4. **Authorization code + PKCE.** The engine runs the flow, receives the
   redirect on a loopback callback it owns, and exchanges the code itself. The
   token lands in `~/.ion/mcp-tokens.json` and is refreshed silently.

Both stores are per-user files with `0600` permissions. `ion mcp logout <name>`
removes a server's token *and* its client registration, so a later login
registers fresh rather than silently reusing a client you believed was revoked.

### Explicit client configuration

A server that does **not** support dynamic registration needs a client the
operator supplies. Configure it under `oauth`; an explicit block always wins
over discovery:

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "client_id": "ion-engine",
        "auth_url": "https://auth.example.com/authorize",
        "token_url": "https://auth.example.com/token",
        "scope": "read write",
        "use_pkce": true
      }
    }
  }
}
```

Then run `ion mcp login internal-api` as usual.

`auth_url` and `token_url` may be omitted when the server publishes metadata:
the engine fills them in from discovery and uses your `client_id`.

#### OAuth fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_id` | `string` | Yes | OAuth client ID |
| `client_secret` | `string` | No | Client secret. Omit for a public client using PKCE. Sent on the token exchange when present, because some providers issue a secret and then reject an exchange that omits it. |
| `auth_url` | `string` | No | Authorization endpoint. Discovered when omitted. |
| `token_url` | `string` | No | Token endpoint. Discovered when omitted. |
| `scope` | `string` | No | Space-separated scopes. Defaults to what the server's metadata advertises. |
| `redirect_uri` | `string` | No | Redirect URI registered with the provider. The engine uses a loopback URI by default. |
| `use_pkce` | `bool` | No | Enable PKCE. Recommended, and used for every dynamically-registered client. |

### Pre-shared tokens

A server authenticated by a static token needs no OAuth at all — put the header
in `headers`:

```json
{
  "mcpServers": {
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-token",
        "X-Team-ID": "engineering"
      }
    }
  }
}
```

### Operator token forwarding

`forwardUserToken` makes the engine stamp the signed-in operator's own OIDC
token on every request to a server, instead of a server-specific grant. Use it
for a first-party service that accepts your identity provider's tokens
directly. It is opt-in per server: not every downstream server should receive
the operator's identity.

### When authorization fails

A server that rejects the connection surfaces the reason and the remediation in
`~/.ion/engine.jsonl`, and `ion mcp list` shows each server's connection and
authorization state separately — an authorized server that is still not
connecting means the stored token is being refused, which `ion mcp logout` then
`ion mcp login` resolves.

## Config layers

MCP server configuration follows the standard four-layer merge. Servers defined in project config override servers with the same name in user config. Enterprise config can restrict which servers are allowed via allowlists and denylists.

### User config (`~/.ion/engine.json`)

Personal MCP servers available in all projects:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token"
      }
    }
  }
}
```

### Project config (`.ion/engine.json`)

Project-specific MCP servers, checked into version control:

```json
{
  "mcpServers": {
    "project-docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"]
    }
  }
}
```

### Enterprise restrictions

See [Enterprise controls](enterprise-controls.md) for allowlist and denylist configuration.
