---
title: Core Concepts
description: Mental model for Ion Engine -- sessions, hooks, extensions, providers, and the engine/harness split.
sidebar_position: 3
---

# Core Concepts

Ion has a layered architecture. Understanding these layers up front will save you time when building on the engine or debugging agent behavior.

## Engine vs. Harness

This is the most important distinction in Ion.

**Engine** is the Go runtime. It executes agent loops, streams LLM responses, runs tools, manages sessions, and emits events over the socket. The engine never blocks for user input, never persists memory, and never decides policy. It provides hooks, events, and pluggable interfaces.

**Harness** is the extension code that runs on top of the engine. A harness registers hooks to intercept and modify engine behavior: injecting system prompts, filtering tool calls, managing permissions, adding custom tools. The harness decides what happens; the engine makes it happen.

This separation means the same engine binary can power completely different agent experiences depending on which harness is loaded.

A third layer, the **client** (desktop app, CLI, mobile remote), connects to the engine over its socket and renders events into a UI. Clients have no access to engine internals. They send commands and receive events.

```
Client (Desktop/CLI/Mobile)
    |
    | NDJSON over Unix socket or TCP
    |
Engine (Go binary)
    |
    | JSON-RPC 2.0 over stdio
    |
Harness (Extension subprocesses)
```

## Sessions

A session is a stateful conversation container. Each session has:

- **Key**: unique identifier (string)
- **Profile**: named configuration preset
- **Working directory**: filesystem root for tool execution
- **Conversation tree**: full message history with branching support
- **Extension context**: loaded hooks and tools

Sessions are created with `start_session` and destroyed with `stop_session`. Multiple sessions can run concurrently, each independent. A session persists its conversation to disk as JSONL and supports tree-based branching, so you can fork a conversation at any point.

The engine manages session lifecycle. The daemon broadcasts events from all sessions to all connected clients. Clients filter by session key.

## Extensions

An extension is a subprocess that communicates with the engine over JSON-RPC 2.0 (stdin/stdout). Extensions can be written in any language. A TypeScript SDK is provided, but anything that reads JSON-RPC from stdin and writes responses to stdout will work.

An extension can:

- **Register hooks**: intercept and modify engine behavior at 55 defined points
- **Register tools**: add custom tools the LLM can invoke
- **Register commands**: add custom client commands
- **Emit events**: send data back through the engine's event stream

Extensions are loaded at session start via the `--extension` flag or through configuration. Each extension runs as its own process, isolated from the engine and from other extensions.

## Hooks

Hooks are the primary way extensions shape agent behavior. Ion defines 55 hooks across 15 categories:

| Category | Examples | Purpose |
|----------|----------|---------|
| Lifecycle | `onStart`, `onStop`, `onError` | React to engine lifecycle events |
| Session | `onSessionStart`, `onSessionEnd` | Initialize/teardown session state |
| Pre-action | `beforeSendPrompt`, `beforeToolCall` | Intercept and modify before execution |
| Content | `onSystemPrompt`, `onToolResult` | Transform content flowing through the engine |
| Per-tool | `beforeBash`, `beforeWrite`, `beforeEdit` | Gate or modify individual tool invocations |
| Context | `onContextFiles`, `onContextIncludes` | Control what context the LLM sees |
| Permission | `onPermissionRequest`, `onPermissionCheck` | Implement approval flows |
| Task | `onTaskCreate`, `onTaskComplete` | Manage sub-agent delegation |
| Elicitation | `onElicitationRequest`, `onElicitationResponse` | Handle structured data collection |

Hooks follow a request/response pattern. The engine sends a hook notification to all registered extensions, collects responses, and merges them. Some hooks can block execution (returning an error or denial), while others modify data in-flight.

See the [hooks reference](../hooks/) for the complete list.

## Agents

An agent is a delegated sub-task. When the LLM decides a problem should be broken into parts, it can use the `Agent` tool to spawn a child agent. The child runs in its own context with a focused prompt, executes tools, and returns a result to the parent.

Agents share the session's conversation tree (creating a branch) but have independent tool execution contexts. The engine manages agent lifecycle; hook behavior applies to agents the same way it applies to the root conversation.

## Providers

Ion supports 14+ LLM providers, all implemented as raw HTTP with SSE parsing. No provider SDKs are used.

**Native providers** (purpose-built implementations):
- Anthropic
- OpenAI
- Google Gemini
- AWS Bedrock
- Azure OpenAI

**OpenAI-compatible providers** (using a shared factory):
- Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI, DeepSeek, Ollama

Providers are configured in `engine.json` under the `providers` key. Each provider entry can set `apiKey`, `baseURL`, and other provider-specific fields. The engine auto-detects available providers from environment variables and configuration.

Provider selection happens per-request via the model name. The engine routes `claude-*` models to Anthropic, `gpt-*` to OpenAI, and so on. You can override routing with explicit provider configuration.

## Tools

The engine ships 14 core tools that are always available, plus 4 optional tools that a harness can opt into.

**Core tools:**

| Tool | Purpose |
|------|---------|
| `Read` | Read file contents |
| `Write` | Write file contents |
| `Edit` | Apply targeted edits to files |
| `Bash` | Execute shell commands |
| `Grep` | Search file contents (ripgrep-based) |
| `Glob` | Find files by pattern |
| `Agent` | Spawn a sub-agent |
| `WebFetch` | Fetch a URL |
| `WebSearch` | Search the web |
| `NotebookEdit` | Edit Jupyter notebooks |
| `LSP` | Language Server Protocol operations |
| `Skill` | Load skill presets |
| `ListMcpResources` | List MCP server resources |
| `ReadMcpResource` | Read an MCP resource |

**Optional tools** (harness opt-in): `TaskCreate`, `TaskList`, `TaskGet`, `TaskStop`.

Every tool invocation passes through the hook system. Per-tool hooks (`beforeBash`, `beforeWrite`, etc.) let extensions gate, modify, or deny individual tool calls.

## Configuration

Ion uses a 4-layer configuration merge:

```
Defaults < User (~/.ion/engine.json) < Project (.ion/engine.json) < Enterprise (MDM)
```

Each layer can set any configuration value. Higher layers override lower ones. The enterprise layer is special: it can **seal** values, making them immutable regardless of what user or project configs specify.

Key configuration areas:

| Area | What it controls |
|------|------------------|
| `backend` | Agent loop implementation (`api` or `cli`) |
| `defaultModel` | Default LLM model |
| `providers` | Provider API keys, base URLs, auth headers |
| `limits` | Max turns and max budget (both default unset/unlimited; engine ships unopinionated) |
| `mcpServers` | MCP server connections |
| `profiles` | Named session presets |
| `network` | Proxy, custom CA, TLS settings |
| `relay` | Remote relay connection for mobile access |
| `featureFlags` | Feature flag sources and overrides |

See the [configuration reference](../configuration/) for the full schema.

## Protocol

All communication between clients and the engine uses NDJSON (newline-delimited JSON) over a Unix domain socket (`~/.ion/engine.sock`) or TCP (`127.0.0.1:21017` on Windows).

**Client to engine**: 20 command types (e.g., `start_session`, `send_prompt`, `stop_session`, `shutdown`).

**Engine to clients**: broadcast events (e.g., `engine_text_delta`, `engine_status`, `engine_tool_use`, `engine_error`). Events are broadcast to all connected clients; clients filter by session key.

The protocol is intentionally simple. Any language that can open a socket and read/write JSON lines can be an Ion client.

See the [protocol reference](../protocol/) for the full command and event catalog.

## Next steps

- [CLI reference](../cli/reference.md) -- all commands and flags
- [Hooks reference](../hooks/) -- the 55-hook catalog
- [Extension SDK](../extensions/) -- build your first extension
- [Configuration](../configuration/) -- engine.json schema
