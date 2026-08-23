# Engine (Go)

Single self-contained binary. Communicates over `~/.ion/engine.sock` (NDJSON). Linux builds are fully static (`CGO_ENABLED=0`, FROM-scratch container); darwin builds use cgo for the Local Network warmup probe (`internal/network/lanwarmup_darwin.go`).

> **Read [`../docs/engine-grounding.md`](../docs/engine-grounding.md) before touching engine code.** It is the canonical framing: engine is a headless library, contracts are additive only, event semantics count, modifying the engine is a restricted operation. This file covers mechanics; the grounding doc covers principles. Both apply.

> **Plan resolution rule (applies to all fix plans for this area):** documenting a defect is not a resolution. See root [`AGENTS.md`](../AGENTS.md) § "Aspirational comments" → "The rule applies to plans, not just code".

> **Role in the consumer landscape.** This package is **the product**. It is consumed by external SDK users, custom harnesses, third-party clients, and the in-repo reference implementations (`desktop/`, `ios/`, `relay/`) — in that order of priority. When making engine changes, the relevant question is *would any plausible external consumer want this?*, not *does desktop use this?* See root [`AGENTS.md`](../AGENTS.md) § "Engine consumers" for the canonical framing.

## Commands

```bash
make build                                                # -> bin/ion
make build-linux                                          # cross-compile linux/amd64
make docker                                               # Docker image from scratch
go test ./internal/<pkg>/...                              # scoped unit (dev loop; add -race for concurrency)
go test -run <TestPrefix> ./internal/<slow-pkg>/          # further scoping for slow packages (see note below)
golangci-lint run ./internal/<pkg>/...                    # scoped lint (dev loop)
go test -race ./...                                       # FULL unit suite — heavy, PR-time only (see root AGENTS.md)
go test -race -tags integration ./tests/integration/...   # integration — heavy, PR-time only
go test -tags e2e -v ./tests/e2e/...                      # e2e (needs API keys)
golangci-lint run                                         # full lint
govulncheck ./...                                         # vuln scan — heavy, PR-time only
```

> The full `go test -race ./...`, integration, and `govulncheck` commands above are **heavy gates** — do not run them during normal development. They run at PR time: CI is authoritative, and `/create-pr` runs the Linux parity subset before pushing. See root [`AGENTS.md`](../AGENTS.md) § "Heavy gates — never run during development".

## E2E config

`tests/e2e/testconfig.json` is gitignored. Copy from `testconfig.example.json`. Resolution: `apiKey` field > `apiKeyEnv` env var. Tests skip if no key.

## Never run a throwaway probe against the operator's live credentials

Verifying engine work against a real external service is legitimate and often the only way to prove a fix — a mock cannot tell you that a provider enforces an `Accept` header or rotates a refresh token on use. **Point every such probe at a throwaway `HOME`, never at `~/.ion`.**

```go
t.Setenv("HOME", t.TempDir())   // in-test isolation
```

```bash
# For an out-of-test probe: isolate HOME *and* the socket, so the run cannot
# touch the operator's daemon, config, or stored tokens.
export TH=$(mktemp -d)
HOME="$TH" ION_SOCKET_PATH="$TH/engine.sock" ION_PID_PATH="$TH/engine.pid" \
  ./bin/ion mcp add ...
```

`~/.ion` holds live OAuth grants, provider API keys, and conversation state. A probe that reads it will also *write* it, and some writes are irreversible from the engine's side:

- **A refresh-token grant is single-use at most providers.** Refreshing rotates the token and invalidates the previous one. A test that exercises a real refresh consumes the operator's grant; when the rotated value is not the one the provider ends up honoring, the stored credential is permanently spent and the only recovery is a fresh interactive login. This has happened here: a live concurrency probe against `api.mobbin.com` consumed the operator's Mobbin grant, and the next session two days later failed with `refresh_token_already_used`. The engine behaved correctly; the credential was gone.
- Writing a server into `~/.ion/engine.json` changes what every subsequent conversation on the machine connects to.
- Starting a daemon on the default socket path competes with the operator's running one.

The rule is not "avoid live testing." It is: **a live probe is disposable, so its state must be disposable too.** Isolate, run, verify, delete the temp dir. If a probe genuinely cannot work without the operator's real credential — proving a specific stored grant is valid, for instance — say so and ask first, because the cost of being wrong is an account the operator has to re-authorize by hand.

The same applies to any test that reads `HOME` implicitly. `internal/session` redirects it once in `TestMain` for exactly this reason (see the comment there): resolving config fresh at session start made every test that starts a session machine-dependent, and one of them began failing only on a machine that had an MCP server configured.

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
| `internal/backend` | RunBackend interface, ApiBackend (agent loop), ClaudeCodeBackend / CodexBackend / AcpBackend (grok, cursor) delegated-CLI subprocesses, HybridBackend (routes per-run by provider + operator preference) |
| `internal/rpcstdio` | Symmetric JSON-RPC 2.0 over stdio (shared transport for the delegated-CLI backends) |
| `internal/codexrpc` | Typed client for the `codex app-server` protocol |
| `internal/acp` | Typed client for the Agent Client Protocol (grok/cursor CLIs) |
| `internal/cliprobe` | Delegated-CLI discovery, install/auth probes + cache, interactive login/logout |
| `internal/providers` | LlmProvider interface + implementations + retry |
| `internal/tools` | Registry, core tools, BashOperations |
| `internal/extension` | SDK, Host (subprocess JSON-RPC), agent discovery (decomposing) |
| `internal/agentdiscovery` | Agent discovery — splitting from `extension` (decomposing) |
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
| `internal/asyncreg` | Async trigger registration (schedules, webhooks) |
| `internal/cost` | Cost centralization — aggregates per-run token costs (ADR-018) |
| `internal/gitcontext` | Git context utilities (branch, commit, diff for prompt injection) |
| `internal/pdf` | PDF-to-text extraction for file attachments |
| `internal/resource` | Resource subsystem — publish, query, delta fan-out |
| `internal/scheduling` | Schedule execution engine (cron, once, interval) |
| `internal/titling` | Conversation auto-titling |
| `internal/watcher` | File/directory watcher for context includes |
| `internal/webhooks` | Inbound webhook route registration and dispatch |
| `internal/workspaces` | Workspace containment (worktree isolation rules checked in the tool loop) and the read-only cross-worktree query tools (WorktreeList, WorktreeCommits, WorktreeDiff) |

`internal/` boundary is compiler-enforced. Outside consumers (desktop, ios, relay) can only reach the wire protocol.

## File-architecture rules

- Cap: 800 lines for `*.go`, 1500 for `*_test.go`. CI hard-fails above. Override: `// @file-size-exception: <reason>` on line 1.
- Same-package multi-file is the idiom. NOT one giant `types.go` per package (`internal/types` is the documented exception — leaf package of cross-cutting types).
- Tests next to source.
- No subfolders inside packages except platform-specific (`process_unix.go`, `process_windows.go`).
- `session/manager.go` and `extension/host.go` are allowlisted. Don't extend; add a new file in the same package.

## Core principle

Engine executes, harness decides. Engine never blocks for user input, never persists user preferences or cross-session memory (conversation-scoped state like `.memory.md` is part of session management, not memory), never decides policy. Engine is UI-agnostic — emits typed data events; clients interpret.

"Never blocks for user input" is a rule about the **socket**: no dispatch arm may hold the client's read loop waiting on a human. Engine-driven interactive flows (delegated-CLI login, OIDC grants) return immediately and continue on a bounded, cancellable background goroutine that may await a user-supplied value delivered by a follow-up command. See [`../docs/engine-grounding.md`](../docs/engine-grounding.md) § 2 for the full framing.

## Event contracts

The engine's typed events are part of the public contract. Two invariants matter most often:

- **`engine_agent_state` is a complete snapshot.** Every emission contains every agent the engine considers live at that instant. Consumers replace their local view with the payload — they do not merge incremental updates and they do not invent retention rules. Every code path that ends an agent's run must transition the registry to a terminal status (done/error/cancelled) and emit a follow-up snapshot. Tests in `internal/session/manager_agent_lifecycle_test.go` enforce this per-path. See [docs/architecture/agent-state.md](../docs/architecture/agent-state.md).
- **No UI assumptions.** Events are typed data. Do not encode renderer-flavored language ("clear the panel", "show as cancelled") in engine code or engine docs. If a consumer wants to derive UI state from an event, that is the consumer's problem.

### Wire naming rule (ADR 008)

The engine owns its outbound wire contract. Every engine wire event carries the `engine_` prefix (see `engine/internal/types/engine_event.go` for the authoritative list). This is a hard invariant — new engine events must follow this convention from their first commit.

**Internal vs. wire names.** `NormalizedEvent` (`internal/types/normalized_event.go`) uses bare names internally. `translateToEngineEvent()` converts them to `engine_*` `EngineEvent` values before anything is written to the socket. Bare internal names never reach a consumer; they are not part of the wire contract.

The engine wire is a **scrutinized contract** (see root `AGENTS.md` § "Contract stability"). Breaking it requires explicit operator approval. Correcting a legacy name that violates the `engine_` convention may be committed as `fix` — not `feat!` — unless it is application-sweeping.

### Vocabulary registry — prose names, never wire names

`docs/vocabulary/terms.json` is the naming authority for Ion concepts, and its generated glossary is [`docs/vocabulary/index.md`](../docs/vocabulary/index.md). Engine entries carry a contract classification: `public-wire` for a published wire contract, `public-sdk` for a published SDK contract, `internal`, or `none`.

Two rules, and the boundary between them is absolute:

- **Prose follows the registry.** When you write an engine doc, comment, or plan about a concept (session, conversation, turn, hook, tool, resource, schedule, compaction), use that concept's canonical term. A new engine concept gets a registry entry in the same change, with an implementation citing the real Go symbol and file. Run `make generate-vocabulary`, then `make check-vocabulary`.
- **The registry never renames a published contract.** A registry entry describes a concept; it has no power over a wire field, an event type string, a hook name, an SDK type, or a JSON key. Adding a canonical term is never a licence to rename any of those. The published name stays exactly as it is, and the entry records it in an implementation. Every contract restriction above still governs: no removal, no rename, no type change, no non-additive payload change without explicit operator approval.

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

Native: Anthropic, OpenAI (raw HTTP SSE), Google Gemini, AWS Bedrock, Azure OpenAI, Anthropic via Foundry, Anthropic via Vertex.
OpenAI-compatible factory: Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI, DeepSeek, Ollama.

No SDK dependencies. Adding a provider: extend the OpenAI-compatible factory or write a native client; do not add a vendor SDK.

## Tools

Core: Read, Write, Edit, Bash, Grep, Glob, Agent, AgentStatus, WebFetch, WebSearch, NotebookEdit, LSP, Skill, ListMcpResources, ReadMcpResource, SearchHistory, WorktreeList, WorktreeCommits, WorktreeDiff.
Optional (harness opt-in): TaskCreate, TaskList, TaskGet, TaskStop.

## Hooks

The engine exposes a large hook surface for extensions. The canonical reference with every hook name, payload shape, and dispatch pattern is [`docs/hooks/reference.md`](../docs/hooks/reference.md). Do not maintain a hook count or category list here; the reference doc is the single source of truth.

Key behavioral patterns for agents working with hooks:

- Extension-lifecycle hooks (`extension_respawned`, `turn_aborted`, `peer_extension_died`, `peer_extension_respawned`) fire on auto-respawn. Auto-respawn is post-run only; mid-turn deaths defer to `handleRunExit`. Strike budget: 3 in 60s, reset after 2min healthy.
- The `before_*` hooks use last-writer-wins merge semantics across multiple handlers. A handler that returns nil abstains.
- The TypeScript SDK runtime automatically unwraps `_payload` wrappers before invoking hook handlers. The engine wraps bare strings (and other non-object values) as `{_payload: value}` for JSON-RPC transport. The SDK detects this shape and passes the unwrapped value to the handler. This is transparent to extension authors but matters when debugging raw RPC frames or writing a custom SDK.

## Async triggers (schedules and webhooks)

Extensions register async triggers — scheduled jobs and inbound webhook routes — via `ion.schedule.*` and `ion.webhooks.register`. These are not hooks; they are delivered through `engine/fire_async` RPCs. The canonical SDK reference is [`docs/extensions/scheduling.md`](../docs/extensions/scheduling.md) and [`docs/extensions/webhooks.md`](../docs/extensions/webhooks.md).

Additive schedule surface (no wire/contract break): `ion.schedule.once({ id, delayMs })` fires a one-shot job `delayMs` ms after registration then auto-deregisters; `ion.schedule.cancel(id)` is the id-addressable complement to `ScheduleHandle.unregister()`; every schedule handler receives an optional `control: ScheduleControl` second argument (`{ jobId, unregister() }`) for in-handler self-unregister. Daily and weekly schedules may set `catchUp: 'auto' | 'manual' | 'none'`; `manual` routes missed startup or suspend-resume slots through `schedule_missed` for both Go and subprocess SDK handlers. When omitted, legacy auto catch-up remains unless the extension itself registered `schedule_missed`; engine transport forwarders do not count as handler registration. A deferred handler retains session-scoped `ctx.fireSchedule()` and `ctx.getScheduleStatus()` after its hook context returns, so it can batch missed work safely. Both auto-deregister paths (`once_complete`) and explicit cancels reuse `engine_schedule_deregistered` — no new event type.

**Background bash completion** is one async delivery path alongside schedules, webhooks, and default Agent dispatch. A `Bash` call with `run_in_background: true, notify_on_complete: true` joins the session's outstanding set; when command exits, engine emits `engine_background_task_complete`, fires `background_task_completed`, and starts a run carrying result under default `wake` delivery. The root parks at turn boundary while commands remain outstanding and wakes once per completion. `Agent` dispatch is asynchronous by default without an extra flag: it returns dispatch ID immediately, keeps child steerable, and injects classified terminal result into parent session. `wait_for_completion: true` is explicit bounded foreground escape hatch. See [ADR-023](../docs/architecture/adr/023-root-session-park-and-wake.md), [ADR-026](../docs/architecture/adr/026-async-agent-dispatch.md), and [`docs/tools/task-tools.md`](../docs/tools/task-tools.md) § "Background bash completion".

## Observability and silent failures

Observability is the most important property of the engine's mechanical implementation — the engine is headless, so logs are the only window into what it does. See root [`AGENTS.md`](../AGENTS.md) § "Logging policy" for the full standard. Engine-specific rules:

- **Every failure branch logs.** `utils.Log`/`utils.Debug`/`utils.Error` (or `utils.LogWithFields`) land in `~/.ion/engine.jsonl`. Never `log.Printf`/`fmt.Printf` for operational logging — stderr is not a reliable channel for the launchd daemon.
- **No bare `_ =` on an error.** `errcheck` runs with `check-blank` + `check-type-assertions` (root `.golangci.yml`), so a discarded error or unchecked type assertion fails CI. Either handle-and-log it, or mark a genuinely-unactionable discard `//nolint:errcheck // <reason>` (deferred `Close()`, best-effort cleanup, or an error already logged internally — e.g. the `Fire*` hooks log via `fireVoid`/`s.fire`). The reason is reviewed; silence is not an option.
- **`(nil, nil)` resolver contracts** and similar "no error but no value" shapes must be guarded before dereferencing — a nil-deref in an unrecovered goroutine crashes the daemon and the diagnostic never lands (see the scheduler/webhook `SessionResolver` guards).

## Conventions

- Logger: `utils.Log("Tag", "message")` → `~/.ion/engine.jsonl` (structured JSONL, `component=engine`). Extensions emit via JSON-RPC `log` notification; the host stamps `component=extension`, `tag=<extension-name>` and writes to the same file.
- Types: import from `internal/types`.
- Cancellation: `context.Context`.
- Parallel tools: `errgroup.Group`.
- Streaming: `<-chan types.LlmStreamEvent`.
- TS extensions: esbuild generates inline source maps for readable stack traces in `engine_error` events.
- `RegisterTool` uses replace-on-duplicate semantics: if a tool with the same name already exists in the SDK registry it is replaced in place, not appended. When an extension subprocess respawns and re-registers its tools during the init handshake, existing entries are updated rather than duplicated. `ExtensionGroup.Tools()` enforces the same invariant at the group level -- last-registered wins when multiple hosts declare the same tool name.

## Done criteria

While developing, run only the **scoped** gates for what you touched — see root [`AGENTS.md`](../AGENTS.md) § "Quality gates (run while developing)". Do **not** run the full `go test -race ./...` sweep, integration tests, or `govulncheck` mid-development; those are heavy gates that run at PR time — CI is authoritative, and `/create-pr` runs the Linux parity subset once before pushing.

1. `go test ./internal/<touched-pkg>/...` passes (add `-race` when concurrency is involved). Run the packages you changed, not the whole tree. **In a known-slow package, scope further with `-run <TestPrefix>`** — some packages wait on real timers and a full package run costs minutes of wall-clock the dev loop should not pay (`internal/server` is ~150s: socket lifecycle, reap/heartbeat waits, per-test broadcast windows). Run the test functions covering the arms you touched; the package's full run happens once at PR time via CI. Do not sit through a multi-minute package sweep to validate a one-handler change.
2. `golangci-lint run ./internal/<touched-pkg>/...` clean for the packages you touched.
3. `make check-file-sizes` passes.
4. Don't `git push`. The full race suite, integration tests, and `govulncheck` run at PR time (CI is authoritative; `/create-pr` runs the Linux subset) — not here.

## Extension SDK source location

The TypeScript SDK that extensions import lives in **two places**:

| Location | Role |
|----------|------|
| `engine/extensions/sdk/ion-sdk/` | **Source of truth.** Edit here. |
| `~/.ion/extensions/sdk/ion-sdk/` | **Installed copy.** Overwritten at build time. Never edit. |

The build process copies the repo source to the installed location. Any edit made only to `~/.ion/extensions/sdk/` will be lost on the next build.

**Always edit `engine/extensions/sdk/ion-sdk/`** for SDK changes — types, runtime, or any other SDK file. The installed copy at `~/.ion/` is read-only from the agent's perspective.

Corollary for harness work: a harness that consumes a brand-new SDK field may need a structural-typing shim until the operator rebuilds the engine/SDK, because the installed copy does not carry the field until that rebuild happens.
