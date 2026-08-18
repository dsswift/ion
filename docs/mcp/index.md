---
title: MCP Integration
description: How Ion Engine integrates with the Model Context Protocol for external tool and resource access.
sidebar_position: 1
---

# MCP Integration

Ion Engine includes a built-in MCP (Model Context Protocol) client. MCP is an open protocol that lets AI agents connect to external data sources and tools through a standardized interface. The engine connects to MCP servers, discovers their resources and tools, and makes them available to the LLM during sessions.

Ion negotiates every MCP revision supported by its protocol SDK: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, and `2026-07-28`. New servers use stateless `2026-07-28`; existing servers continue through the legacy initialize handshake. See [ADR-029](../architecture/adr/029-dual-era-mcp-sdk.md) for capability and transport decisions.

## What MCP provides

MCP servers expose two things:

- **Resources**: data the LLM can read (files, database records, API responses, documentation)
- **Tools**: actions the LLM can invoke (query a database, create a ticket, fetch a web page)

The engine acts as an MCP client. It connects to the configured MCP servers at a session's first prompt (lazily, so idle sessions cost nothing), discovers what they offer, and presents those capabilities to the LLM alongside the engine's built-in tools.

## Transport types

| Transport | How it works | Use case |
|-----------|-------------|----------|
| **stdio** | Engine spawns the MCP server as a subprocess and communicates via stdin/stdout | Local tools, filesystem access, CLI wrappers |
| **http** | Engine connects to a remote server over StreamableHTTP | Remote APIs and hosted services; the current MCP network transport |
| **sse** | Engine connects over HTTP Server-Sent Events | Remote servers still speaking the older protocol |
| **ws** | Engine speaks MCP over a WebSocket (alias: `websocket`) | Servers exposing a socket endpoint |

## Built-in MCP tools

The engine registers two tools that let the LLM interact with MCP resources:

| Tool | Purpose |
|------|---------|
| `ListMcpResources` | Enumerate available resources from all connected MCP servers |
| `ReadMcpResource` | Fetch the content of a specific resource by URI |

MCP tools registered by servers are automatically added to the LLM's tool set. They appear alongside built-in tools and are invoked the same way.

## Quick example

Add a remote server and authorize it:

```bash
ion mcp add mobbin https://api.mobbin.com/mcp
ion mcp login mobbin
```

`ion mcp login` opens your browser; the engine discovers the server's
authorization server, registers itself as a client if the provider supports
dynamic registration, completes the PKCE exchange, and stores the grant. The
same operations are available in the desktop under Settings → MCP Servers.

A local server needs no authorization:

```bash
ion mcp add filesystem --command npx --arg -y \
  --arg @modelcontextprotocol/server-filesystem --arg /home/user/docs
```

Either form writes to `~/.ion/engine.json`, which you can also edit directly:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"]
    }
  }
}
```

The engine reads the server map fresh at each session's first prompt, so a
server added while the daemon is running connects on the very next prompt in a
new conversation — no restart.

## Next steps

- [Configuration](configuration.md) -- full config reference for every transport, plus OAuth discovery and dynamic registration
- [`ion mcp`](../cli/reference.md#ion-mcp) -- the command-line surface
- [Usage](usage.md) -- how MCP tools and resources work in sessions
- [Enterprise controls](enterprise-controls.md) -- allowlists, denylists, and governance
