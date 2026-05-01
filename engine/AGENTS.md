# Engine (Go)

Single static binary. Communicates over `~/.ion/engine.sock` (NDJSON).

## Commands

```bash
make build                                                # -> bin/ion
make build-linux                                          # cross-compile linux/amd64
make docker                                               # Docker image from scratch
go test -race ./...                                       # unit
go test -race -tags integration ./tests/integration/...   # integration
go test -tags e2e -v ./tests/e2e/...                      # e2e (needs API keys)
golangci-lint run                                         # only-new-issues
govulncheck ./...                                         # vuln scan
```

## E2E config

`tests/e2e/testconfig.json` is gitignored. Copy from `testconfig.example.json`. Resolution: `apiKey` field > `apiKeyEnv` env var. Tests skip if no key.

## Test helpers

`tests/helpers/mock_provider.go`: `MockProvider`, `MockBackend`. Builders: `TextResponse()`, `ToolCallResponse()`, `MultiTurnResponse()`.

## Integration test files

| File | Covers |
|------|--------|
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

## Packages

| Package | Purpose |
|---------|---------|
| `cmd/ion` | CLI entry point |
| `internal/types` | Cross-cutting types (events, messages, config). One file per concept. |
| `internal/protocol` | NDJSON wire format |
| `internal/server` | Unix socket server, multi-client broadcast |
| `internal/session` | SessionManager: lifecycle, event routing (decomposing) |
| `internal/backend` | RunBackend interface, ApiBackend (agent loop) |
| `internal/providers` | LlmProvider interface + implementations + retry |
| `internal/tools` | Registry, 14 core tools, BashOperations |
| `internal/extension` | SDK, Host (subprocess JSON-RPC), agent discovery (decomposing) |
| `internal/conversation` | Tree sessions, JSONL persistence, migration |
| `internal/config` | 4-layer config, enterprise MDM, merge |
| `internal/compaction` | Fact extraction, partial, restore |
| `internal/sandbox` | Shell validation, Seatbelt/bwrap wrapping |
| `internal/permissions` | PermissionEngine, patterns, LLM classifier |
| `internal/auth` | 5-level credential resolver, keychain |
| `internal/network` | Proxy, custom CA, HTTP transport |
| `internal/telemetry` | Structured events, spans, exporters |
| `internal/mcp` | MCP client (stdio + SSE) |
| `internal/transport` | Transport interface, Unix, Relay WebSocket |
| `internal/insights` | Insight extraction, secret scanning |
| `internal/context` | File walker, includes, presets |
| `internal/skills` | Loader, presets |
| `internal/featureflags` | Static/file/HTTP sources |
| `internal/filelock` | Advisory PID locking |
| `internal/recorder` | NDJSON session recording |
| `internal/export` | Session export (JSON/MD/HTML) |
| `internal/normalizer` | Raw event -> NormalizedEvent |
| `internal/modelconfig` | models.json, provider init, tiers |
| `internal/stream` | NDJSON line parser |
| `internal/utils` | Logger, git context |

`internal/` boundary is compiler-enforced. Outside consumers (desktop, ios, relay) can only reach the wire protocol.

## File-architecture rules

- Cap: 800 lines for `*.go`, 1500 for `*_test.go`. CI hard-fails above. Override: `// @file-size-exception: <reason>` on line 1.
- Same-package multi-file is the idiom. NOT one giant `types.go` per package (`internal/types` is the documented exception — leaf package of cross-cutting types).
- Tests next to source.
- No subfolders inside packages except platform-specific (`process_unix.go`, `process_windows.go`).
- `session/manager.go` and `extension/host.go` are allowlisted. Don't extend; add a new file in the same package.

## Core principle

Engine executes, harness decides. Engine never blocks for user input, never persists memory, never decides policy. Engine is UI-agnostic — emits typed data events; clients interpret.

## Socket protocol

`~/.ion/engine.sock`. Client → Server: NDJSON `ClientCommand`. Server → Client: NDJSON `ServerMessage` (broadcast). 16 command types. See `protocol/protocol.go`.

## Providers

Native: Anthropic, OpenAI (raw HTTP SSE), Google Gemini, AWS Bedrock, Azure OpenAI.
OpenAI-compatible factory: Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI, DeepSeek, Ollama.

No SDK dependencies. Adding a provider: extend the OpenAI-compatible factory or write a native client; do not add a vendor SDK.

## Tools

Core: Read, Write, Edit, Bash, Grep, Glob, Agent, WebFetch, WebSearch, NotebookEdit, LSP, Skill, ListMcpResources, ReadMcpResource.
Optional (harness opt-in): TaskCreate, TaskList, TaskGet, TaskStop.

## Hooks

59 total: 13 lifecycle + 5 session + 2 pre-action + 7 content + 14 per-tool + 3 context + 2 permission + 1 file + 2 task + 2 elicitation + 1 context-inject + 3 capability + 4 extension-lifecycle.

Extension-lifecycle hooks (`extension_respawned`, `turn_aborted`, `peer_extension_died`, `peer_extension_respawned`) fire on auto-respawn. Auto-respawn is post-run only; mid-turn deaths defer to `handleRunExit`. Strike budget: 3 in 60s, reset after 2min healthy. Payloads: `docs/hooks/reference.md`.

## Conventions

- Logger: `utils.Log("Tag", "message")` → `~/.ion/engine.log`.
- Types: import from `internal/types`.
- Cancellation: `context.Context`.
- Parallel tools: `errgroup.Group`.
- Streaming: `<-chan types.LlmStreamEvent`.
- TS extensions: esbuild generates inline source maps for readable stack traces in `engine_error` events.

## Done criteria

1. `go test -race ./...` passes.
2. Public-surface changes: `go test -race -tags integration ./tests/integration/...`
3. `golangci-lint run` clean.
4. `make check-file-sizes` passes.
5. Don't `git push`.
