# Engine (Go)

Single self-contained binary. Listens on `<ION_DATA_DIR>/engine.sock` (default `~/.ion/engine.sock`; a loopback port on Windows; `ION_SOCKET_PATH` overrides), NDJSON. Its in-repo client is the server's engine bridge (`server/src/engine/`). Linux builds are fully static (`CGO_ENABLED=0`, FROM-scratch container); darwin builds use cgo for the Local Network warmup probe (`internal/network/lanwarmup_darwin.go`) and the FSEvents workspace watcher (`internal/watcher/fsevents_darwin.go`).

Read [`../docs/engine-grounding.md`](../docs/engine-grounding.md) before touching engine code. It holds the principles; this file holds the mechanics.

## Commands

Run from `engine/`.

```bash
make build                                                # -> bin/ion
make build-linux                                          # cross-compile linux/amd64
make docker                                               # Docker image from scratch
go test ./internal/<pkg>/...                              # scoped unit (dev loop; -race for concurrency)
go test -run <TestPrefix> ./internal/<slow-pkg>/          # scope further in slow packages (internal/server ~150s)
golangci-lint run ./internal/<pkg>/...                    # scoped lint (dev loop)
go test -tags e2e -v ./tests/e2e/...                      # e2e (needs API keys)
```

The full `go test -race ./...`, `go test -race -tags integration ./tests/integration/...`, and `govulncheck ./...` are heavy gates. CI runs them on every push to `main`; `govulncheck` runs nightly (root `AGENTS.md` § "Heavy gates — never run during development").

E2E config: `tests/e2e/testconfig.json` is gitignored. Copy `testconfig.example.json`. `apiKey` wins over `apiKeyEnv`. Tests skip with no key.

Test helpers: `tests/helpers/mock_provider.go` (`MockProvider`, `MockBackend`, `TextResponse()`, `ToolCallResponse()`, `MultiTurnResponse()`).

## Never probe against the operator's live `~/.ion`

A live probe against a real service is fine. Its state must be disposable.

```go
t.Setenv("HOME", t.TempDir())   // in-test isolation
```

```bash
export TH=$(mktemp -d)
HOME="$TH" ION_SOCKET_PATH="$TH/engine.sock" ION_PID_PATH="$TH/engine.pid" ./bin/ion mcp add ...
```

`~/.ion` holds live OAuth grants, API keys, and conversation state. Refresh tokens are single-use at most providers: a probe that refreshes one spends the operator's grant for good. Writing `~/.ion/engine.json` changes every later conversation. A daemon on the default socket competes with the operator's. If a probe truly needs the real credential, ask first. `internal/session` redirects `HOME` in `TestMain` for the same reason.

## Profiling

- `debug.pprof.listen` in `engine.json` (for example `"127.0.0.1:6060"`) serves `net/http/pprof`. Unset is off. A non-loopback host is refused and logged; the engine runs without it.
- `ion debug profile cpu|heap|goroutine|trace [--seconds N]` asks the running daemon for one capture (`debug_profile` command). It writes to `<data dir>/profiles/` and prints the path. `cpu` and `trace` record for N seconds (default 10, max 300).
- `make bench` (repo root) runs every `Benchmark*` under `internal/` six times into `engine/bench.txt` (gitignored); `make bench-compare OLD=<file> NEW=<file>` runs `benchstat`.

## Core principle

Engine executes, harness decides (grounding § 2). "Never blocks for user input" is about the **socket**: no dispatch arm holds the client's read loop waiting on a human. Engine-driven interactive flows (delegated-CLI login, OIDC grants) return `{started: true}` and continue on a bounded, cancellable goroutine that awaits a value delivered by a follow-up command.

## File-architecture rules

- Same-package multi-file is the idiom. No giant `types.go` per package; `internal/types` is the one exception (leaf package of cross-cutting types).
- Tests next to source. No subfolders inside a package except platform files (`process_unix.go`, `process_windows.go`).
- A file near the cap takes no new code. Don't extend it; add a new file in the same package. `session/manager.go` is the standing example.
- `internal/` is compiler-enforced. Outside consumers reach only the wire protocol.

Find a package with `ls engine/internal` or `graphify query "<symbol>"`.

## Event and wire rules

- `engine_agent_state` is a complete snapshot (grounding § 4). `internal/session/manager_agent_lifecycle_test.go` pins every termination path; a new path extends it.
- `NormalizedEvent` (`internal/types/normalized_event.go`) uses bare names. `translateToEngineEvent()` adds `engine_` before the socket. Bare names never reach a consumer. Wire list: `internal/types/engine_event.go`.
- Contract manifest: `internal/types/contract_test.go` writes `internal/types/testdata/contracts.json`. Commit the regenerated manifest with the Go change. Full sync steps: root `AGENTS.md` § "Cross-language contract sync".
- Commands: `internal/protocol/protocol.go`.
- Nothing that varies with a run's mode or from run to run goes in the tool list or the system prompt. Both are the start of the prompt a provider caches; a change rewrites the whole cached conversation. Say it in a message appended to the conversation, and enforce it when a tool is called ([ADR-038](../docs/architecture/adr/038-mode-invariant-prompt-prefix.md)). `backend.prompt_prefix` warns when a prefix changes between runs.

## Providers and tools

- No vendor SDKs. A new provider extends the OpenAI-compatible factory or is a native client in `internal/providers`.
- Tool registry: `internal/tools/registry.go`. Harness opt-in tools: `internal/tools/optional.go`. Reference: [`docs/tools/`](../docs/tools/).

## Hooks

Reference: [`docs/hooks/reference.md`](../docs/hooks/reference.md). Never keep a hook list or count here.

- Lifecycle hooks (`extension_respawned`, `turn_aborted`, `peer_extension_died`, `peer_extension_respawned`) fire on auto-respawn. Auto-respawn is post-run only; a mid-turn death defers to `handleRunExit`. Strike budget: 3 in 60s, reset after 2 min healthy.
- `before_*` hooks merge last-writer-wins across handlers. A handler returning nil abstains.
- The engine wraps non-object payloads as `{_payload: value}` for JSON-RPC. The TS SDK unwraps before calling the handler. It matters when reading raw frames or writing a custom SDK.

## Async delivery

Schedules and webhooks are not hooks; they arrive through `engine/fire_async`. References: [`docs/extensions/scheduling.md`](../docs/extensions/scheduling.md), [`docs/extensions/webhooks.md`](../docs/extensions/webhooks.md). Background bash completion and async `Agent` dispatch: [ADR-023](../docs/architecture/adr/023-root-session-park-and-wake.md), [ADR-026](../docs/architecture/adr/026-async-agent-dispatch.md), [`docs/tools/task-tools.md`](../docs/tools/task-tools.md).

## Engine-specific logging rules

- `errcheck` runs with `check-blank` and `check-type-assertions` (root `.golangci.yml`). A bare `_ =` or unchecked assertion fails CI. Mark a real discard `//nolint:errcheck // <reason>`.
- Guard `(nil, nil)` resolver returns before dereferencing. A nil deref in an unrecovered goroutine kills the daemon before its log line lands.
- Extensions log through a JSON-RPC `log` notification; the host stamps `component=extension`, `tag=<name>`.

## Conventions

- Types from `internal/types`. Cancellation via `context.Context`. Parallel tools via `errgroup.Group`. Streaming via `<-chan types.LlmStreamEvent`.
- TS extensions build with inline source maps, so `engine_error` stacks are readable.
- `RegisterTool` replaces on duplicate name. A respawned extension re-registers in place. `ExtensionGroup.Tools()` is last-registered-wins across hosts.

## Extension SDK source location

| Location | Role |
|----------|------|
| `engine/extensions/sdk/ion-sdk/` | Source of truth. Edit here. |
| `~/.ion/extensions/sdk/ion-sdk/` | Installed copy. Overwritten at build. Never edit. |
