---
title: Using MCP in Sessions
description: How MCP tools and resources appear to the LLM and how to use them in agent sessions.
sidebar_position: 3
---

# Using MCP in Sessions

When MCP servers are configured, their tools and resources become available to the LLM automatically. No additional session configuration is needed.

## Server lifecycle

1. **Session start**: The engine connects to all configured MCP servers. stdio servers are spawned as subprocesses. SSE servers receive an HTTP connection.
2. **Discovery**: The engine queries each server for its available tools and resources.
3. **Registration**: MCP tools are added to the LLM's tool set. Resources are made available through the built-in `ListMcpResources` and `ReadMcpResource` tools.
4. **Session end**: stdio servers are terminated. SSE connections are closed.

If an MCP server fails to start or connect, the engine logs the error and continues without that server. Other MCP servers and built-in tools are unaffected.

## MCP tools

Tools registered by MCP servers appear in the LLM's tool list alongside the engine's built-in tools (Read, Write, Bash, etc.). The LLM invokes them based on their name and description, just like any other tool.

MCP tool names are prefixed with the server name to avoid collisions. A tool named `search` from a server named `github` appears as `github__search`.

### Tool invocation flow

1. The LLM decides to call an MCP tool based on the tool description and current task.
2. The engine routes the call to the appropriate MCP server.
3. The MCP server executes the tool and returns the result.
4. The engine returns the result to the LLM as tool output.

MCP tool calls go through the engine's permission system. If permissions are configured, MCP tool invocations are subject to the same allow/ask/deny rules as built-in tools.

## MCP resources

Resources are data that MCP servers expose for the LLM to read. The engine provides two built-in tools for interacting with resources:

### ListMcpResources

Lists all available resources from all connected MCP servers.

```
Tool: ListMcpResources
Input: {}
Output: [
  {
    "uri": "file:///home/user/docs/readme.md",
    "name": "readme.md",
    "description": "Project README",
    "mimeType": "text/markdown",
    "server": "filesystem"
  }
]
```

### ReadMcpResource

Reads the content of a specific resource by URI.

```
Tool: ReadMcpResource
Input: { "uri": "file:///home/user/docs/readme.md" }
Output: {
  "contents": "# Project\n\nThis is the project README..."
}
```

## How the LLM uses MCP

The LLM sees MCP tools and resources as part of its available capabilities. It decides when to use them based on:

- **Tool descriptions**: MCP servers provide descriptions for their tools. Clear, specific descriptions lead to better tool selection by the LLM.
- **Resource names and descriptions**: When the LLM needs information, it can list and read resources.
- **Task context**: If the user asks about data that an MCP server provides, the LLM will use the appropriate MCP tools to access it.

No special prompting is needed. The LLM treats MCP tools the same as built-in tools.

## Multiple servers

When multiple MCP servers are configured, all their tools and resources are available simultaneously. The engine handles routing each tool call to the correct server based on the tool name prefix.

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/docs"]
    },
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    "internal-api": {
      "type": "sse",
      "url": "https://mcp.internal.example.com/sse",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

The LLM can use tools from any of these servers within a single session. For example, it might read a file from `filesystem`, look up a GitHub issue from `github`, and query an internal API from `internal-api` -- all in the same conversation turn.

## Error handling

When an MCP tool call fails:

- The error message is returned to the LLM as tool output.
- The LLM can decide to retry, try an alternative approach, or report the error to the user.
- The engine does not automatically retry failed MCP calls.

When an MCP server disconnects mid-session:

- Subsequent tool calls to that server return an error.
- Other MCP servers and built-in tools continue working.
- The engine does not automatically reconnect stdio servers. SSE connections may reconnect depending on the server implementation.
