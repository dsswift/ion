---
title: MCP Tools
description: ListMcpResources and ReadMcpResource tools for accessing MCP server resources.
sidebar_position: 3
---

# MCP Tools

Two core tools expose [Model Context Protocol](https://modelcontextprotocol.io/) server resources to the LLM. These tools are always registered and work with any MCP server connected to the engine.

## Overview

MCP servers expose structured resources (files, database records, API data) through a standard protocol. The engine connects to MCP servers via stdio or SSE transport. These tools let the LLM discover and read those resources within a session.

## ListMcpResources

List all resources available from a named MCP server.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Name of the MCP server to query |

### Response

Returns a list of resources, each with:

- **URI** -- unique resource identifier
- **Name** -- human-readable name
- **Description** -- optional description of the resource

Example output:

```
- file:///project/schema.sql: Database Schema -- SQL schema for the application database
- file:///project/.env.example: Environment Template -- Example environment configuration
```

Returns "No resources available." if the server has no resources.

### Errors

- Server name is required
- Server not found or not connected
- Server returned an error

## ReadMcpResource

Read the content of a specific resource by URI.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Name of the MCP server |
| `uri` | string | yes | URI of the resource to read (from ListMcpResources output) |

### Response

Returns the resource content. Two content types are supported:

- **Text** -- returned as plain text
- **Blob** -- returned as a summary with byte count and MIME type (e.g. `[base64 blob, 4096 chars, mime: image/png]`)

### Errors

- Server and URI are both required
- Server not found or not connected
- Resource not found
- Server returned an error

## Workflow

A typical MCP resource access flow:

1. The LLM calls `ListMcpResources` with a server name to discover available resources.
2. The LLM selects a resource URI from the list.
3. The LLM calls `ReadMcpResource` with the server name and URI to read the content.
4. The resource content is available in the conversation for the LLM to use.

## MCP Server Configuration

MCP servers are configured through the engine config or the `mcpConfigPath` in the extension config. Server names in tool calls must match the names in the configuration. The engine manages server lifecycle (start, connect, disconnect) independently of these tools.
