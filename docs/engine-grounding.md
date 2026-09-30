# Engine Grounding

Read this before any work that touches `engine/`. Section numbers are cited from code comments; keep them stable.

---

## 1. The engine is the product

The engine is a headless Go library that emits a complete, self-describing event stream over a Unix socket (`~/.ion/engine.sock`, NDJSON). The server, desktop, iOS, relay, and harness extensions are its consumers. External consumers come first ([engine consumers](architecture/engine-consumers.md)).

- The engine never assumes a UI exists.
- The engine never encodes renderer policy, retention rules, animation cues, or any other client concern.
- Engine code and docs never use renderer language ("clear the panel", "show as cancelled"). The engine emits typed data; consumers interpret it.
- A consumer never patches around an engine gap with invented local behavior. If a consumer needs data the engine does not emit, the engine emits it: additively, generically, for every consumer.

## 2. Engine executes. Harness decides.

| Layer | Where | Role |
|-------|-------|------|
| Engine | `engine/` (Go) | Hooks, events, tools, LLM streaming, agent discovery mechanics. Headless. |
| Server | `server/` (TS) | Studio wire, auth, per-Environment orchestration. Pairs with one engine. |
| Harness | `~/.ion/extensions/` (TS via SDK) | Policy: which agents load, delegation routing, workflow patterns. |
| Client | `desktop/`, `ios/` | Renders UI. |

The engine never:

- Blocks the socket for user input.
- Persists user preferences or cross-session memory.
- Decides policy (who can do what, what to load, how to orchestrate).
- Knows that a UI exists.

The engine does persist conversation-scoped operational state (`.tree.jsonl`, `.llm.jsonl`, `.memory.md`). That is session management and compaction infrastructure, not memory.

"Blocks for user input" is about the socket, not every goroutine. A dispatch arm never holds the client's read loop waiting on a human. An interactive flow the engine drives (delegated-CLI login, OIDC grant) starts from a command that returns at once (`{started: true}`), then runs on a background goroutine that may await a user-supplied value. It always has a bounded deadline and is always cancellable by a follow-up command. The engine transports that value; it decides nothing about it.

## 3. Contracts are additive only

Never ship a breaking change to a published contract without explicit operator approval.

### What counts as a contract

| Surface | Key files |
|---------|-----------|
| Wire protocol | `engine/internal/protocol/protocol.go` (`ClientCommand`, `ServerMessage`, NDJSON framing) |
| NormalizedEvent variants and fields | `engine/internal/types/normalized_event.go` (mirrored in TS and Swift) |
| SDK types and hook signatures | `engine/internal/extension/sdk_types.go`, `sdk_hook_types.go` |
| Hook names and payload shapes | `engine/internal/extension/sdk_hooks_*.go` |
| Engine events clients read | Any event type or field a client reads |
| Event semantics | Snapshot vs. incremental, replace vs. merge, idempotency, when it fires (§ 4) |

### Allowed

- New fields with zero-value defaults.
- New event variants, hooks, optional parameters.
- Bug fixes to existing behavior (defects, not redefinitions).
- A versioned alternative (`ToolCallV2`) beside an untouched original.

### Forbidden

- Remove or rename a field, type, constant, hook name, or event variant.
- Change a field's type.
- Change a hook payload non-additively.
- Remove or reorder positional arguments in an SDK callback.
- Change wire framing or envelope structure.
- Change an event's semantics (snapshot to incremental or back), even with the same wire shape.
- Stop emitting an event on one of its established triggers. An exception needs an ADR that records the rationale and migration impact (e.g. [ADR-003](architecture/adr/003-state-events-vs-workflow-events.md)).

### Typed events are the complete signaling surface

When the engine has a signal, it emits one typed `NormalizedEvent` variant and stops. Never also surface it in `TaskCompleteEvent.Result`, `TextChunkEvent`, a synthetic system message, or a log line. Doing so forces one UI-shaped reading on every consumer and corrupts headless pipelines that treat stream content as the model's verbatim output. Root [`AGENTS.md`](../AGENTS.md) § "The typed-event corollary".

### Cross-language sync

Go is the source of truth. `engine/internal/types/contract_test.go` writes JSON field names to `engine/internal/types/testdata/contracts.json`; TS and Swift validate against it. Steps: root [`AGENTS.md`](../AGENTS.md) § "Cross-language contract sync". Verify with `make check-contracts` and the scoped contract tests; the full suites run at PR time.

## 4. Event semantics: the snapshot contract

`engine_agent_state` is the canonical example, and the rule generalizes:

> Every `engine_agent_state` event is a **complete snapshot** of every agent the engine considers live at that instant. Consumers replace their local view with the payload. They do not merge, do not keep absent entries, and do not invent retention rules. An empty `agents: []` is the authoritative "no agents live" signal, not a no-op.

- Every path that ends an agent's run either transitions it to a terminal status (`done` / `error` / `cancelled`) and emits a follow-up snapshot, or drops it from the next snapshot. There is no third option.
- `engine/internal/session/manager_agent_lifecycle_test.go` pins this per path. A new termination path extends it.
- Reconnecting clients receive the current snapshot unconditionally, even when empty, via `ReconcileState`.
- A "past dispatches" history is built from conversation history by the consumer, not from retained agent-state entries. The dispatch registry's own bounded record of ended dispatches (`ext/list_dispatch_history`) is a separate pull query for extensions; it never feeds `engine_agent_state`.

A new event decides up front whether it is a snapshot or an incremental update. The choice is part of the contract.

## 5. When an engine change is justified

An engine change reaches every consumer, so it needs a reason stated as engine mechanics, not one client's convenience.

1. First check whether existing engine data already answers the need. Often it does, and the fix is in the consumer.
2. If it does not, the engine gains a generic, additive primitive any plausible consumer could use: a field, an event, a hook, an optional parameter. Never a UI-shaped one.
3. Never fake the missing capability in a consumer or harness (a timer standing in for a schedule kind, polling standing in for an event). Name the gap and build the primitive.
4. Every change ships tests that pin the new behavior and its semantics.

## 6. Settings live with their owner

Every persisted setting has one scope, declared in `packages/shared/src/settings-registry.ts`. An Environment setting is one value for a whole server, changed only by a connection holding `admin`. An Account setting is a person's own on one server. Personal and Device settings live on the client. See [Settings scopes](configuration/settings-scopes.md).

The engine has no opinion on any of them. It neither persists nor reads them. A setting that must influence the engine arrives as config at session start, passed in by the server. For a Personal preference the server takes the value from the conversation's own stamp, written by the client that created or last prompted it.

## 7. Logging is part of the contract

Every operation must be reconstructible from logs alone.

- `utils.Log` / `utils.Debug` / `utils.Error` with a consistent tag and identifiers (provider id, model id, session key, request id, status code).
- Never `log.Printf` or `fmt.Printf` for operational logging. The daemon's stderr is lost; logs go to `~/.ion/engine.jsonl`.
- Log both sides of every branch that decides the outcome.
- Entering an under-instrumented path, add the logging first, then make the change. Logging is permanent.

## 8. Quality gates

While developing, run the scoped set once the change is stable:

1. `go test ./internal/<pkg>/...` for touched packages (`-race` for concurrency; `-run <TestPrefix>` in slow packages).
2. `golangci-lint run ./internal/<pkg>/...`.
3. `make check-file-sizes`, and `make check-contracts` when a shared type changed.
4. TS and Swift mirrors updated if a shared type changed.

The full race suite, integration tests, and `govulncheck` are PR-time gates (root `AGENTS.md` § "Heavy gates — never run during development"). Never `git push`.

## 9. File and package discipline

- Caps: 800 lines for `*.go`, 1500 for `*_test.go`. Override only with `// @file-size-exception: <reason>` on line 1.
- Same-package multi-file is the idiom. No giant `types.go` per package; `internal/types` is the exception.
- Tests live next to source.
- `internal/` is compiler-enforced. External consumers reach the engine only through the wire protocol.
- New code goes in a new file in the right package. A file near the cap takes no new code.

## 10. House rules

- Engine is headless. No UI assumptions.
- Engine executes; harness decides; clients render.
- Contracts are additive only. Semantics count.
- Snapshots replace; incrementals merge. Pick one and document it.
- Typed events are the complete signaling surface.
- An engine change needs an engine reason, and a real gap gets a generic primitive, never a consumer workaround.
- Settings belong to the scope that owns them.
- Log everything, success and failure, with identifiers.
- Never `--no-verify`. Never `git push`.

---

If a task contradicts this document, surface the contradiction before writing code.
