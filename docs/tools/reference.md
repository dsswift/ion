---
title: Tool Reference
description: Complete reference for all Ion Engine tools with parameters and behavior.
sidebar_position: 2
---

# Tool Reference

All 14 core tools and 4 optional tools. Each entry shows the tool name, description, input parameters, and behavior.

## Core Tools

### Read

Read a file from the filesystem. Returns content with line numbers in `cat -n` format.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `offset` | number | no | Line number to start from (1-based) |
| `limit` | number | no | Maximum lines to read |
| `pages` | string | no | Page range for PDF files (e.g. "1-5", "3"). Max 20 pages per request. |

Reads text files with line numbers. For PDF files, extracts text from specified pages. Returns an error if the path is a directory.

### Write

Write content to a file, creating parent directories as needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `content` | string | yes | Content to write |

Creates intermediate directories with `0755` permissions. Writes the file with `0644` permissions. Overwrites existing files.

### Edit

Replace string matches in a file. Supports exact match and fuzzy matching.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path to file |
| `old_string` | string | yes | String to find and replace |
| `new_string` | string | yes | Replacement string |
| `replace_all` | boolean | no | Replace all occurrences (default: false) |

Two-phase matching: exact match first, then fuzzy. Fuzzy matching applies NFKC normalization, smart quote replacement, Unicode dash normalization, special space normalization, and per-line trailing whitespace trimming.

### Bash

Execute a bash command and return its output.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | yes | The bash command to execute |
| `timeout` | number | no | Timeout in milliseconds (default: 120000) |

Runs through the pluggable `BashOperations` backend. Returns stdout and stderr. Non-zero exit codes are reported as tool errors. The backend supports sandboxing via Seatbelt (macOS) or bubblewrap (Linux).

### Grep

Search file contents using ripgrep, falling back to `grep -rn` if `rg` is unavailable.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Regex pattern to search for |
| `path` | string | no | Directory or file to search in |
| `glob` | string | no | Glob pattern to filter files (e.g. "*.ts") |
| `output_mode` | string | no | `"content"`, `"files_with_matches"`, or `"count"` |

Uses ripgrep when available for performance. Falls back to `grep -rn` otherwise.

### Glob

Find files matching a glob pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Glob pattern to match (e.g. "**/*.ts") |
| `path` | string | no | Directory to search in |

Uses the `doublestar` library for `**` support. Results are sorted. Defaults to the session working directory when `path` is omitted.

### Agent

Launch a new agent to handle complex, multi-step tasks autonomously.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent to perform |
| `description` | string | no | Short description of what the agent will do |
| `model` | string | no | Model override for the child agent. Invalid values warn and fall back to the session default. |

Spawns a child session via the session-scoped `AgentSpawner`. The child agent has its own context and tool access. Returns the agent's final output.

### WebFetch

Fetch content from a URL. Returns text content from web pages (HTML converted to text) or raw content for APIs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | The URL to fetch |
| `method` | string | no | HTTP method: `"GET"` or `"POST"` (default: GET) |
| `headers` | object | no | HTTP headers as key-value pairs |
| `body` | string | no | Request body for POST requests |
| `maxBytes` | number | no | Max response size in bytes (default: 5MB) |

Includes SSRF protection: blocks requests to private IP ranges (RFC 1918), loopback, and link-local addresses. HTML responses are converted to plain text by stripping scripts, styles, and tags.

### WebSearch

Search the web for information.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | number | no | Maximum number of results (default: 5) |

Requires one of the following environment variables: `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`. The backend is selected based on which key is present.

### NotebookEdit

Read, edit, or run Jupyter notebook (.ipynb) cells.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | yes | `"read"`, `"edit"`, `"run"`, `"add"`, or `"delete"` |
| `path` | string | yes | Path to .ipynb file |
| `cellIndex` | number | no | Cell index (0-based) for edit/run/delete |
| `content` | string | no | New cell content for edit/add |
| `cellType` | string | no | Cell type for add: `"code"` or `"markdown"` (default: code) |

Parses and manipulates Jupyter notebook JSON format directly. The `run` action executes cells via a subprocess.

### LSP

Language Server Protocol operations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operation` | string | yes | `"definition"`, `"references"`, `"hover"`, `"symbols"`, `"workspace_symbols"`, or `"diagnostics"` |
| `file_path` | string | no | File path (required for most operations) |
| `line` | number | no | Line number (0-based, for definition/references/hover) |
| `character` | number | no | Character offset (0-based, for definition/references/hover) |
| `query` | string | no | Search query (for workspace_symbols) |

Requires an `LspManager` to be configured by the harness. Returns an error if no LSP manager is available.

### Skill

Invoke a loaded skill by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skill` | string | yes | The name of the skill to invoke |
| `args` | string | no | Optional arguments to pass to the skill |

Returns the skill content for execution. Skills are loaded from the skills registry, which the harness populates at session start.

### ListMcpResources

List resources available from a connected MCP server. See [MCP Tools](mcp-tools.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Name of the MCP server to list resources from |

### ReadMcpResource

Read a specific resource from a connected MCP server by URI. See [MCP Tools](mcp-tools.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Name of the MCP server |
| `uri` | string | yes | URI of the resource to read |

## Optional Tools

These tools are not registered by default. Call `RegisterTaskTools()` from harness code to enable them. See [Task Tools](task-tools.md) for details.

| Tool | Description |
|------|-------------|
| TaskCreate | Create an asynchronous sub-task in a separate session |
| TaskList | List all active and recently completed tasks |
| TaskGet | Get status and result of a task by ID |
| TaskStop | Stop a running task |
