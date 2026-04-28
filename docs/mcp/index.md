---
title: MCP Integration
description: How Ion Engine integrates with the Model Context Protocol for external tool and resource access.
sidebar_position: 1
---

# MCP Integration

Ion Engine includes a built-in MCP (Model Context Protocol) client. MCP is an open protocol that lets AI agents connect to external data sources and tools through a standardized interface. The engine connects to MCP servers, discovers their resources and tools, and makes them available to the LLM during sessions.

## What MCP provides

MCP servers expose two things:

- **Resources**: data the LLM can read (files, database records, API responses, documentation)
- **Tools**: actions the LLM can invoke (query a database, create a ticket, fetch a web page)

The engine acts as an MCP client. It connects to one or more MCP servers at session start, discovers what they offer, and presents those capabilities to the LLM alongside the engine's built-in tools.

## Transport types

The engine supports two MCP transport mechanisms:

| Transport | How it works | Use case |
|-----------|-------------|----------|
| **stdio** | Engine spawns the MCP server as a subprocess and communicates via stdin/stdout | Local tools, filesystem access, CLI wrappers |
| **SSE** | Engine connects to a remote MCP server via HTTP Server-Sent Events | Remote APIs, shared services, cloud-hosted tools |

## Built-in MCP tools

The engine registers two tools that let the LLM interact with MCP resources:

| Tool | Purpose |
|------|---------|
| `ListMcpResources` | Enumerate available resources from all connected MCP servers |
| `ReadMcpResource` | Fetch the content of a specific resource by URI |

MCP tools registered by servers are automatically added to the LLM's tool set. They appear alongside built-in tools and are invoked the same way.

## Quick example

Add an MCP server to your engine config:

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

The engine spawns the filesystem MCP server at session start. The LLM can then list and read files from `/home/user/docs` through the MCP protocol.

## Next steps

- [Configuration](configuration.md) -- full config reference for stdio, SSE, and OAuth
- [Usage](usage.md) -- how MCP tools and resources work in sessions
- [Enterprise controls](enterprise-controls.md) -- allowlists, denylists, and governance
