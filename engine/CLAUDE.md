# ion-engine (Go)

Standalone Go agent runtime. Single static binary, zero runtime deps. Communicates via Unix domain socket (`~/.ion/engine.sock`).

## Build and Test

```bash
make build        # -> bin/ion (~7.8MB stripped)
make test         # go test ./... (unit tests only)
make build-linux  # cross-compile linux/amd64
make docker       # Docker image from scratch
```

### Test Suite

Three tiers. Unit tests run always, integration use mocks, e2e hit live APIs.

```bash
go test ./...                                    # unit (269 tests)
go test -tags integration ./tests/integration/... # integration (54 tests)
go test -tags e2e -v ./tests/e2e/...             # e2e (5 tests, need API keys)
```

### E2E Configuration

E2E tests load `tests/e2e/testconfig.json` (gitignored). Copy from `testconfig.example.json`:

```json
{
  "anthropic": {
    "apiKeyEnv": "ION_API_KEY",
    "baseURL": "https://your-gateway.example.com",
    "testModel": "claude-haiku-4-5-20251001"
  },
  "openai": {
    "apiKeyEnv": "OPENAI_API_KEY",
    "baseURL": "",
    "testModel": "gpt-4.1-mini"
  }
}
```

Resolution order: `apiKey` field > `apiKeyEnv` env var. Tests skip if no key found. BaseURL points at your AI gateway (or leave empty for direct API).

### Test Helpers

`tests/helpers/mock_provider.go`: `MockProvider` (scripted LLM responses) + `MockBackend` (RunBackend stub). Event builders: `TextResponse()`, `ToolCallResponse()`, `MultiTurnResponse()`.

### Integration Tests

| File | What |
|------|------|
| `server_lifecycle_test.go` | Socket start/stop, multi-client, stale recovery |
| `session_lifecycle_test.go` | Start/stop, prompt, abort, plan mode, events |
| `api_backend_test.go` | Agent loop: text, tools, budget, cancel, hooks |
| `conversation_roundtrip_test.go` | JSONL round-trip, branching, migration, compaction |
| `protocol_contract_test.go` | Wire format, NDJSON framing, all 16 commands |
| `normalizer_test.go` | Normalize pipeline, event round-trip |
| `tools_test.go` | Real Read/Write/Edit/Bash/Grep/Glob execution |

## Architecture

```
Client --[Unix socket, NDJSON]--> Server
  --> SessionManager --> ExtensionHost + ApiBackend
                                          |
                                    LlmProvider.Stream()
                                          |
                                    Tool execution (parallel)
```

## Package Layout

| Package | Purpose | Lines |
|---------|---------|-------|
| `cmd/ion` | CLI entry point | ~350 |
| `internal/types` | All struct definitions (events, messages, config) | ~800 |
| `internal/protocol` | NDJSON wire format: ClientCommand, ServerMessage | ~220 |
| `internal/server` | Unix socket server, multi-client broadcast | ~150 |
| `internal/session` | SessionManager: session lifecycle, event routing | ~200 |
| `internal/backend` | RunBackend interface, ApiBackend (agent loop) | ~400 |
| `internal/providers` | LlmProvider interface, 6 implementations, retry | ~1200 |
| `internal/tools` | Registry, 14 core tools, BashOperations | ~1500 |
| `internal/extension` | SDK (55 hooks), Host (subprocess JSON-RPC), agent discovery | ~400 |
| `internal/conversation` | Tree sessions, JSONL persistence, migration | ~600 |
| `internal/config` | 4-layer config, enterprise MDM, merge | ~350 |
| `internal/compaction` | Fact extraction, partial, restore | ~200 |
| `internal/sandbox` | Shell validation, Seatbelt/bwrap wrapping | ~250 |
| `internal/permissions` | PermissionEngine, patterns, LLM classifier | ~200 |
| `internal/auth` | 5-level credential resolver, keychain | ~200 |
| `internal/network` | Proxy, custom CA, HTTP transport | ~160 |
| `internal/telemetry` | Structured events, spans, exporters | ~200 |
| `internal/mcp` | MCP client (stdio + SSE) | ~300 |
| `internal/transport` | Transport interface, Unix, Relay WebSocket | ~200 |
| `internal/insights` | Insight extraction, secret scanning | ~300 |
| `internal/context` | File walker, includes, presets | ~250 |
| `internal/skills` | Loader, presets | ~150 |
| `internal/featureflags` | Static/file/HTTP sources | ~150 |
| `internal/filelock` | Advisory PID locking | ~100 |
| `internal/recorder` | NDJSON session recording | ~80 |
| `internal/export` | Session export (JSON/MD/HTML) | ~200 |
| `internal/normalizer` | Raw event -> NormalizedEvent | ~200 |
| `internal/modelconfig` | models.json, provider init, tiers | ~150 |
| `internal/stream` | NDJSON line parser | ~50 |
| `internal/utils` | Logger, git context | ~100 |

## Core Principle: Engine Executes, Harness Decides

Engine never blocks for user input. Engine never persists memory. Engine never decides policy.
Engine provides hooks, events, and pluggable interfaces. Harness engineer decides behavior.

**Engine is UI-agnostic.** The engine emits typed data events over the socket. It has no concept of panels, dialogs, buttons, or layouts. Clients (desktop, CLI, web) interpret events however they choose. Extensions communicate state through hook responses and the event stream, never through UI primitives.

## Socket Protocol

Path: `~/.ion/engine.sock`

Client -> Server: NDJSON `ClientCommand` (see `protocol/protocol.go`)
Server -> Client: NDJSON `ServerMessage` (broadcast to all clients)

16 command types. Wire-compatible with TypeScript engine.

## Providers (16)

Native: Anthropic (raw HTTP SSE), OpenAI (raw HTTP SSE), Google Gemini, AWS Bedrock, Azure OpenAI.
OpenAI-compatible factory: Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI, DeepSeek, Ollama.

No SDK dependencies for providers -- all raw HTTP with SSE parsing.

## Tools (14 core + 4 optional)

**Core (always registered):** Read, Write, Edit, Bash, Grep, Glob, Agent, WebFetch, WebSearch, NotebookEdit, LSP, Skill, ListMcpResources, ReadMcpResource.

**Optional (harness opt-in):** TaskCreate, TaskList, TaskGet, TaskStop.

## Extension Hooks (59 total)

13 lifecycle + 5 session + 2 pre-action + 7 content + 14 per-tool + 3 context + 2 permission + 1 file + 2 task + 2 elicitation + 1 context-inject + 3 capability + 4 extension-lifecycle = 59 hooks.

The 4 extension-lifecycle hooks (`extension_respawned`, `turn_aborted`, `peer_extension_died`, `peer_extension_respawned`) fire when the engine auto-respawns a crashed subprocess. See `docs/hooks/reference.md` for payloads. Auto-respawn is post-run only; mid-turn deaths defer to `handleRunExit`. Strike budget: 3 in 60s, reset after 2min healthy.

## Conventions

- Logger: `utils.Log("Tag", "message")` -- writes to ~/.ion/engine.log
- Types: import from `internal/types`
- Cancellation: `context.Context` (replaces AbortController)
- Parallel tools: `errgroup.Group` (replaces Promise.allSettled)
- Streaming: `<-chan types.LlmStreamEvent` (replaces AsyncIterable)
- Source maps: esbuild generates inline source maps for TypeScript extensions (readable stack traces in engine_error events)
