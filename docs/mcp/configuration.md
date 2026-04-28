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
| `type` | `string` | Yes | Transport type: `"stdio"` or `"sse"` |
| `command` | `string` | stdio only | Command to execute |
| `args` | `string[]` | No | Command arguments |
| `url` | `string` | SSE only | Remote server URL |
| `env` | `map[string]string` | No | Environment variables passed to the server process (stdio) or included in requests (SSE) |
| `headers` | `map[string]string` | No | HTTP headers for SSE connections |
| `oauth` | `McpOAuthConfig` | No | OAuth 2.0 configuration for authenticated SSE connections |

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

## SSE transport

The engine connects to a remote MCP server over HTTP using Server-Sent Events for the server-to-client channel and HTTP POST for client-to-server messages.

```json
{
  "mcpServers": {
    "remote-api": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer your-api-token",
        "X-Team-ID": "engineering"
      }
    }
  }
}
```

### Headers

Custom headers are included in both the SSE connection request and all subsequent HTTP POST requests to the server. Use headers for API keys, bearer tokens, and routing metadata.

### Network considerations

SSE connections are long-lived HTTP connections. They are subject to:

- Enterprise proxy settings (see [Network configuration](../enterprise/network.md))
- Custom CA certificate configuration
- TLS verification settings

Ensure your proxy and firewall configuration allows long-lived HTTP connections to the MCP server endpoint.

## OAuth configuration

For MCP servers that require OAuth 2.0 authentication, configure the `oauth` field:

```json
{
  "mcpServers": {
    "authenticated-api": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "oauth": {
        "client_id": "ion-engine",
        "client_secret": "client-secret-value",
        "auth_url": "https://auth.example.com/authorize",
        "token_url": "https://auth.example.com/token",
        "scope": "read write",
        "redirect_uri": "http://localhost:8765/callback",
        "use_pkce": true
      }
    }
  }
}
```

### OAuth fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_id` | `string` | Yes | OAuth client ID |
| `client_secret` | `string` | No | OAuth client secret. Omit for public clients using PKCE. |
| `auth_url` | `string` | Yes | Authorization endpoint URL |
| `token_url` | `string` | Yes | Token endpoint URL |
| `scope` | `string` | No | Space-separated list of requested scopes |
| `redirect_uri` | `string` | No | Redirect URI for the authorization flow. Defaults to a localhost callback. |
| `use_pkce` | `bool` | No | Enable PKCE (Proof Key for Code Exchange). Recommended for public clients. |

The engine handles the OAuth flow automatically:

1. Requests an authorization code from `auth_url`
2. Exchanges the code for an access token at `token_url`
3. Includes the access token in the `Authorization` header for SSE requests
4. Refreshes the token when it expires

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
