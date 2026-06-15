# Engine (Go)

Single static binary. Communicates over `~/.ion/engine.sock` (NDJSON).

> **Read [`../docs/engine-grounding.md`](../docs/engine-grounding.md) before touching engine code.** It is the canonical framing: engine is a headless library, contracts are additive only, event semantics count, modifying the engine is a restricted operation. This file covers mechanics; the grounding doc covers principles. Both apply.

> **Plan resolution rule (applies to all fix plans for this area):** documenting a defect is not a resolution. See root [`AGENTS.md`](../AGENTS.md) § "Aspirational comments" → "The rule applies to plans, not just code".

> **Role in the consumer landscape.** This package is **the product**. It is consumed by external SDK users, custom harnesses, third-party clients, and the in-repo reference implementations (`desktop/`, `ios/`, `relay/`) — in that order of priority. When making engine changes, the relevant question is *would any plausible external consumer want this?*, not *does desktop use this?* See root [`AGENTS.md`](../AGENTS.md) § "Engine consumers" for the canonical framing.

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
| `protocol_contract_test.go` | Wire format, NDJSON framing, the full command-type set |
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
| `internal/backend` | RunBackend interface, ApiBackend (agent loop), CliBackend (Claude Code subprocess), HybridBackend (routes per-run by model) |
| `internal/providers` | LlmProvider interface + implementations + retry |
| `internal/tools` | Registry, core tools, BashOperations |
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

Engine executes, harness decides. Engine never blocks for user input, never persists user preferences or cross-session memory (conversation-scoped state like `.memory.md` is part of session management, not memory), never decides policy. Engine is UI-agnostic — emits typed data events; clients interpret.

## Event contracts

The engine's typed events are part of the public contract. Two invariants matter most often:

- **`engine_agent_state` is a complete snapshot.** Every emission contains every agent the engine considers live at that instant. Consumers replace their local view with the payload — they do not merge incremental updates and they do not invent retention rules. Every code path that ends an agent's run must transition the registry to a terminal status (done/error/cancelled) and emit a follow-up snapshot. Tests in `internal/session/manager_agent_lifecycle_test.go` enforce this per-path. See [docs/architecture/agent-state.md](../docs/architecture/agent-state.md).
- **No UI assumptions.** Events are typed data. Do not encode renderer-flavored language ("clear the panel", "show as cancelled") in engine code or engine docs. If a consumer wants to derive UI state from an event, that is the consumer's problem.

## Contract manifest (cross-language sync)

Go is the source of truth for shared types. `internal/types/contract_test.go` uses reflection to extract JSON field names from all shared structs into `internal/types/testdata/contracts.json`. TS and Swift tests validate against this file at CI time.

**When you add/rename a field in any struct under `internal/types/` (NormalizedEvent variants, StatusFields, EngineConfig, etc.):**

1. Make your change.
2. Run: `go test ./internal/types/ -run TestContractManifest -update` — regenerates the golden manifest.
3. Commit the updated `testdata/contracts.json` alongside your Go change.
4. Update the TS and Swift mirrors (see root `AGENTS.md` for the full workflow).

If you forget step 2, `go test ./internal/types/` fails. If you forget step 4, desktop and iOS CI fail.

## Socket protocol

`~/.ion/engine.sock`. Client → Server: NDJSON `ClientCommand`. Server → Client: NDJSON `ServerMessage` (broadcast). See `protocol/protocol.go` for the command set.

## Providers

Native: Anthropic, OpenAI (raw HTTP SSE), Google Gemini, AWS Bedrock, Azure OpenAI.
OpenAI-compatible factory: Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI, DeepSeek, Ollama.

No SDK dependencies. Adding a provider: extend the OpenAI-compatible factory or write a native client; do not add a vendor SDK.

## Tools

Core: Read, Write, Edit, Bash, Grep, Glob, Agent, WebFetch, WebSearch, NotebookEdit, LSP, Skill, ListMcpResources, ReadMcpResource.
Optional (harness opt-in): TaskCreate, TaskList, TaskGet, TaskStop.

## Hooks

The engine exposes a large hook surface for extensions. The canonical reference with every hook name, payload shape, and dispatch pattern is [`docs/hooks/reference.md`](../docs/hooks/reference.md). Do not maintain a hook count or category list here; the reference doc is the single source of truth.

Key behavioral patterns for agents working with hooks:

- Extension-lifecycle hooks (`extension_respawned`, `turn_aborted`, `peer_extension_died`, `peer_extension_respawned`) fire on auto-respawn. Auto-respawn is post-run only; mid-turn deaths defer to `handleRunExit`. Strike budget: 3 in 60s, reset after 2min healthy.
- The `before_*` hooks use last-writer-wins merge semantics across multiple handlers. A handler that returns nil abstains.
- The TypeScript SDK runtime automatically unwraps `_payload` wrappers before invoking hook handlers. The engine wraps bare strings (and other non-object values) as `{_payload: value}` for JSON-RPC transport. The SDK detects this shape and passes the unwrapped value to the handler. This is transparent to extension authors but matters when debugging raw RPC frames or writing a custom SDK.

## Conventions

- Logger: `utils.Log("Tag", "message")` → `~/.ion/engine.log`.
- Types: import from `internal/types`.
- Cancellation: `context.Context`.
- Parallel tools: `errgroup.Group`.
- Streaming: `<-chan types.LlmStreamEvent`.
- TS extensions: esbuild generates inline source maps for readable stack traces in `engine_error` events.
- `RegisterTool` uses replace-on-duplicate semantics: if a tool with the same name already exists in the SDK registry it is replaced in place, not appended. When an extension subprocess respawns and re-registers its tools during the init handshake, existing entries are updated rather than duplicated. `ExtensionGroup.Tools()` enforces the same invariant at the group level -- last-registered wins when multiple hosts declare the same tool name.

## Done criteria

1. `go test -race ./...` passes.
2. Public-surface changes: `go test -race -tags integration ./tests/integration/...`
3. `golangci-lint run` clean.
4. `make check-file-sizes` passes.
5. Don't `git push`.
