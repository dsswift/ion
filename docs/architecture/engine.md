---
title: Engine Internals
description: Package layout, data flow, and agent loop architecture for the Ion Engine.
sidebar_position: 2
---

# Engine Internals

The Ion Engine is a single Go binary. It runs as a daemon, listens on a Unix socket, and executes LLM-driven agent loops with tool use, branching conversations, and a 55-hook extension system.

## Package layout

| Package | Purpose |
|---------|---------|
| `cmd/ion` | CLI entry point, flag parsing |
| `internal/server` | Unix socket server, multi-client broadcast |
| `internal/session` | SessionManager: lifecycle, event routing, extension wiring |
| `internal/backend` | RunBackend interface, ApiBackend (agent loop), ToolServer |
| `internal/providers` | LlmProvider interface, 14+ implementations, retry, SSE parsing |
| `internal/tools` | Registry, 14 core tools, parallel execution via errgroup |
| `internal/extension` | SDK (55 hooks), Host (subprocess JSON-RPC 2.0) |
| `internal/conversation` | Tree sessions, JSONL persistence, migration |
| `internal/config` | 4-layer config merge, enterprise MDM, sealed fields |
| `internal/protocol` | NDJSON wire format: ClientCommand, ServerMessage |
| `internal/permissions` | Permission engine, pattern matching, LLM classifier |
| `internal/sandbox` | Shell validation, Seatbelt (macOS) and bwrap (Linux) |
| `internal/mcp` | MCP client (stdio + SSE transports) |
| `internal/auth` | 5-level credential resolver, keychain integration |
| `internal/telemetry` | Structured events, spans, OTEL exporters |
| `internal/compaction` | Context window management, fact extraction |
| `internal/normalizer` | Raw provider events to NormalizedEvent pipeline |
| `internal/transport` | Transport interface: Unix socket, Relay WebSocket |
| `internal/types` | All struct definitions (events, messages, config) |
| `internal/context` | File walker, includes, presets |
| `internal/insights` | Insight extraction, secret scanning |
| `internal/network` | Proxy, custom CA, HTTP transport |
| `internal/modelconfig` | models.json parsing, provider init, model tiers |
| `internal/featureflags` | Static, file, and HTTP flag sources |
| `internal/filelock` | Advisory PID locking |
| `internal/recorder` | NDJSON session recording |
| `internal/export` | Session export (JSON, Markdown, HTML) |
| `internal/skills` | Skill loader, presets |
| `internal/stream` | NDJSON line parser |
| `internal/utils` | Logger, git context helpers |

## Data flow

### Prompt to response

```
Client sends: {"type":"prompt","text":"..."}
    │
    ▼
Server (NDJSON parser)
    │
    ▼
SessionManager.HandleCommand()
    │
    ▼
ApiBackend.RunPrompt(ctx, prompt)
    │
    ├── Build messages array (conversation history + prompt)
    ├── Fire PrePrompt hooks
    │
    ▼
LlmProvider.Stream(ctx, messages, tools)
    │
    ├── SSE stream from provider API
    ├── Parse content blocks (text, tool_use)
    │
    ▼
For each tool_use block:
    ├── Fire PreToolUse hook (permission check)
    ├── Execute tool (parallel via errgroup)
    ├── Fire PostToolUse hook
    ├── Append tool_result to messages
    │
    ▼
Loop back to LlmProvider.Stream() with updated messages
    │
    ▼
When no more tool calls:
    ├── Fire PostResponse hooks
    ├── Persist to conversation JSONL
    ├── Broadcast result to all connected clients
    └── Done
```

### Agent loop

The `ApiBackend` implements a standard agent loop:

1. Send messages + available tools to the LLM provider
2. Stream the response, emitting events as content arrives
3. If the response contains tool calls, execute them in parallel
4. Append tool results to the conversation
5. Go back to step 1
6. Stop when the response contains no tool calls, or the context budget is exhausted

The loop runs inside a `context.Context` for cancellation. Abort signals from any client cancel the loop immediately.

## Socket protocol

The engine listens on `~/.ion/engine.sock` (Unix) or `127.0.0.1:21017` (Windows/TCP).

**Wire format**: newline-delimited JSON (NDJSON). One JSON object per line, terminated by `\n`.

**Direction**:
- Client to server: `ClientCommand` (16 command types)
- Server to client: `ServerMessage` (broadcast to all connected clients)

The protocol is stateless from the server's perspective. Any client can send any command at any time. The server broadcasts all events to all connected clients. Client-side filtering is expected.

## Providers

14+ LLM providers, all implemented as raw HTTP with SSE parsing. No SDK dependencies.

**Native implementations** (provider-specific SSE format):
- Anthropic
- OpenAI
- Google Gemini
- AWS Bedrock
- Azure OpenAI

**OpenAI-compatible factory** (shared implementation, different base URLs):
- Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI, DeepSeek, Ollama

All providers implement the `LlmProvider` interface:

```go
type LlmProvider interface {
    Stream(ctx context.Context, req StreamRequest) (<-chan LlmStreamEvent, error)
    Name() string
}
```

## Tools

14 core tools, always registered:

| Tool | Description |
|------|-------------|
| Read | Read file contents |
| Write | Write file contents |
| Edit | Find-and-replace in files |
| Bash | Execute shell commands |
| Grep | Content search (ripgrep) |
| Glob | File pattern matching |
| Agent | Spawn sub-agent |
| WebFetch | HTTP GET/POST |
| WebSearch | Web search |
| NotebookEdit | Jupyter notebook editing |
| LSP | Language Server Protocol |
| Skill | Load and execute skills |
| ListMcpResources | List MCP server resources |
| ReadMcpResource | Read MCP server resource |

4 optional tools (harness opt-in): TaskCreate, TaskList, TaskGet, TaskStop.

Tools execute in parallel using `errgroup.Group`. Each tool call runs in its own goroutine with the parent context for cancellation.

## Extension system

Extensions are external processes that communicate with the engine via JSON-RPC 2.0 over stdio. The extension host manages subprocess lifecycle, message routing, and hook dispatch.

55 hooks across 13 categories:

| Category | Count | Examples |
|----------|-------|---------|
| Lifecycle | 13 | OnInit, OnShutdown, OnConnect |
| Session | 5 | OnSessionStart, OnSessionEnd |
| Pre-action | 2 | PrePrompt, PreToolUse |
| Content | 7 | OnTextChunk, OnToolResult |
| Per-tool | 14 | PreBash, PostBash, PreWrite, PostWrite |
| Context | 3 | OnContextInject, OnContextRequest |
| Permission | 2 | OnPermissionRequest, OnPermissionDecision |
| File | 1 | OnFileChange |
| Task | 2 | OnTaskCreate, OnTaskComplete |
| Elicitation | 2 | OnElicitStart, OnElicitEnd |
| Capability | 3 | OnCapabilityRegister, OnCapabilityQuery |

Extensions can be written in any language. The SDK provides TypeScript bindings (`ion-sdk.ts`) for the most common case.

## Configuration

Four-layer merge, applied in order (later layers override earlier):

1. **Built-in defaults** -- compiled into the binary
2. **User config** -- `~/.ion/config.json`
3. **Project config** -- `.ion/config.json` in the working directory
4. **Enterprise MDM policy** -- sealed fields that cannot be overridden by lower layers

Enterprise sealing allows IT admins to lock down provider choices, model access, tool availability, and extension permissions across a fleet.
