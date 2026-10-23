---
title: Tool Search
description: How the engine loads MCP and extension tools on demand, on the API and claude-code backends.
sidebar_position: 6
---

# Tool Search

A session can carry far more tools than a model should read on every turn. Tool search keeps deferrable tools out of the tool list, names them, and lets the model load the ones a task needs.

## Which tools defer

| Tool | Deferrable |
|---|---|
| Engine built-ins (Read, Bash, Agent, ...), plan-mode tools, AskUserQuestion | Never |
| Client-declared tools and capability tools | Never |
| Extension tools | Yes, unless the extension sets `alwaysLoad` |
| Tools from MCP servers in `engine.json` `mcpServers` | Yes |

An extension marks a tool the model needs on every turn with `alwaysLoad: true` (TypeScript) or `AlwaysLoad: true` (Go). Keep the set small: every always-load tool is read on every turn. See [Tools Registration](../extensions/tools-registration.md).

## Configuration

One setting in [`engine.json`](../configuration/engine-json.md#toolsearch) governs both backends.

```json
{ "toolSearch": { "mode": "auto:5" } }
```

| `mode` | API backend | claude-code backend |
|---|---|---|
| omitted | `auto` at 10% | the Claude Code CLI's own default (deferral on) |
| `on` | defer every deferrable tool | `ENABLE_TOOL_SEARCH=true` |
| `off` | load every tool | `ENABLE_TOOL_SEARCH=false` |
| `auto` | defer once deferrable definitions reach 10% of the model's context window | `ENABLE_TOOL_SEARCH=auto:10` |
| `auto:N` | the same at N percent (0-100) | `ENABLE_TOOL_SEARCH=auto:N` |

An unparseable value is logged (`backend.tool_search` or `backend.claude_code`) and treated as omitted.

## API backend

When deferral applies, the run sends two engine tools in place of the deferred ones.

- **ToolSearch** names every deferred tool in its description. It takes `query` (keywords, or `select:Name1,Name2` for exact names) and `max_results` (default 5), and returns each match's name, description, and input schema.
- **ToolCall** takes `name` and `input` and runs the named deferred tool.

A ToolCall becomes the tool it names before any check runs, so the plan policy, permissions, the tool gate, the `tool_call` hooks, and telemetry all see the real tool and its arguments. The tool list itself never changes during a conversation, so the provider's cached prefix holds ([ADR-038](../architecture/adr/038-mode-invariant-prompt-prefix.md)). The deferral decision depends on the configured mode, the tool set, and the model, never on plan mode. ToolSearch is in the default plan-mode tool set: it reads definitions and runs nothing.

The engine's own ToolSearch serves every provider. Anthropic's server-side tool search is not used: its result blocks would need their own handling in the stream, the conversation sanitizer, and compaction, and it is not offered on every Anthropic route.

## claude-code backend

The CLI defers MCP tools behind its own ToolSearch tool. The engine passes the configured mode as `ENABLE_TOOL_SEARCH`, or leaves the CLI's default when none is set. The engine's MCP server marks its own bridged tools, and extension tools that set `alwaysLoad`, with `_meta["anthropic/alwaysLoad"] = true` in `tools/list`, so the CLI keeps them loaded. Everything else on that server, servers bridged from `mcpServers`, and MCP servers the CLI loads from its own configuration load on demand. `ToolSearch` is always on the CLI's `--allowedTools`.

Per-tool `alwaysLoad` needs a Claude Code CLI that honors `_meta["anthropic/alwaysLoad"]` (see the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)).
