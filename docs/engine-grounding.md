# Engine Grounding Prompt

Paste (or reference) this at the start of any session that may touch `engine/`. It is the non-negotiable framing for engine work.

---

## 1. The engine is the product

The engine is a headless Go library that emits a complete, self-describing event stream over a Unix socket (`~/.ion/engine.sock`, NDJSON). Desktop, iOS, relay, and harness extensions are **consumers** of this stream. They are not the engine's audience — they are its dependents.

Internalize the consequences:

- The engine must not assume a UI exists.
- The engine must not encode renderer policy, retention rules, animation cues, or any other client-side concern.
- The engine must not be "patched around" by a consumer inventing local behavior to compensate for an engine gap. If the consumer needs different data, the engine emits different data — cleanly, additively, and for everyone.
- Engine code and engine docs must never use renderer-flavored language ("clear the panel", "show as cancelled", "highlight the row"). Engine emits typed data; consumers interpret.

If a UI requirement seems to demand an engine change, that is a **major red flag**. Stop and justify it as core engine functionality before writing a line of Go.

## 2. Engine executes. Harness decides.

| Layer | Where | Role |
|-------|-------|------|
| Engine | `engine/` (Go) | Hooks, events, tools, LLM streaming, agent discovery mechanics. Headless. |
| Harness | `~/.ion/extensions/` (TS via SDK) | Policy: which agents load, delegation routing, workflow patterns. |
| Client | `desktop/`, `ios/` | Renders UI from engine events. |

The engine never:

- Blocks for user input.
- Persists user preferences or cross-session memory.
- Decides policy (who can do what, what to load, how to orchestrate).
- Knows that a UI exists.

> **Note:** The engine *does* persist conversation-scoped operational state (`.tree.jsonl`, `.llm.jsonl`, `.memory.md`) as part of session management. This is not "memory" in the LLM sense — it is compaction infrastructure that the engine owns. The prohibition targets user preference persistence and durable cross-session memory features, which belong to the harness or client.

When labeling work, decide first: is this engine, harness, or client? If a harness or client gap is caused by a missing engine capability, call that out explicitly — but the default answer is almost always "fix it in the consumer."

## 3. Contracts are sacred. Breaking changes are a stop-the-line event.

Every consumer depends on published contracts. **Never ship a breaking change to a published contract.** If you think you need to, stop and discuss with the user — never commit it silently.

### What counts as a contract

| Surface | Key files |
|---------|-----------|
| Wire protocol | `engine/internal/protocol/protocol.go` (`ClientCommand`, `ServerMessage`, NDJSON framing) |
| NormalizedEvent variants & fields | `engine/internal/types/normalized_event.go` (mirrored in TS and Swift) |
| SDK types & hook signatures | `engine/internal/extension/sdk_types.go`, `sdk_hook_types.go` |
| Hook names & payload shapes | `engine/internal/extension/sdk_hooks_*.go` |
| Engine events consumed by clients | Any event type or field a client reads |
| **Event semantics** | Snapshot vs. incremental, replace vs. merge, idempotency — see §4 |

### Allowed (non-breaking, additive)

- Add new fields with zero-value defaults.
- Add new event variants, new hooks, new optional parameters.
- Fix bugs in existing behavior (defects, not redefinitions).
- Version a new alternative (`ToolCallV2`) when a design must evolve — leave the original intact.

### Forbidden (breaking)

- Remove or rename a field, type, constant, hook name, or event variant.
- Change a field's type.
- Alter a hook's payload shape non-additively.
- Remove or reorder positional arguments in an SDK callback signature.
- Change wire-protocol message framing or envelope structure.
- Change the **semantics** of an existing event (e.g. turning a snapshot into an incremental update, or vice versa) — even if the wire shape is unchanged.
- Stop emitting an existing event on one of its established triggers, even when the wire shape is unchanged. Consumers depend on *when* events fire, not just on their schema. Exceptions require an ADR documenting the semantic rationale and the migration impact; the ADR is the single source of truth for what changed and why (e.g. [ADR-003](architecture/adr/003-state-events-vs-workflow-events.md) for the `engine_plan_mode_changed` / `ExitPlanMode` trigger removal).

### Cross-language sync (mandatory when shared types change)

Go is the source of truth. `engine/internal/types/contract_test.go` extracts JSON field names into `engine/internal/types/testdata/contracts.json`. TS and Swift validate against it.

When you change a shared type:

1. Make the Go change in `engine/internal/types/`.
2. Regenerate the manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`.
3. Update `desktop/src/shared/__tests__/contract-sync.test.ts` and the TS type definitions.
4. Update the Swift type in `ios/IonRemote/Models/` and the Swift contract test.
5. Verify: `make check-contracts`, `npm test`, `make ios-check`.

Skipping any step trips CI with a clear drift message. Do not bypass it.

## 4. Event semantics: the snapshot contract

`engine_agent_state` is the canonical example, and the rule generalizes:

> Every `engine_agent_state` event is a **complete snapshot** of every agent the engine considers live at that instant. Consumers replace their local view with the payload. They do **not** merge, do **not** preserve absent entries, and do **not** invent retention rules. An empty `agents: []` is the authoritative "no agents live" signal — not a no-op.

Concretely:

- Every code path that ends an agent's run must transition the registry to a terminal status (`done` / `error` / `cancelled`) and emit a follow-up snapshot — **or** drop the agent from the next snapshot. There is no third option.
- Tests in `engine/internal/session/manager_agent_lifecycle_test.go` enforce this per-path. New termination paths must extend these tests.
- Reconnecting clients receive the current snapshot unconditionally (even when empty) via `ReconcileState`.
- "History of past dispatches" features are built from conversation history, not retained agent-state entries. That is a consumer concern, full stop.

When designing a new event, decide and document up front: is it a snapshot or an incremental update? The choice is part of the contract.

## 5. Modifying the engine is a restricted operation

Engine changes carry blast radius across desktop, iOS, relay, and every harness extension in the wild. Treat every engine PR as:

- Defaulting to "no" until proven necessary.
- Requiring justification as core engine mechanics (not consumer convenience).
- Additive over modifying — new fields, new variants, new hooks, new optional params.
- Accompanied by tests that lock in the new behavior, including its semantics.

If a desktop, iOS, or harness requirement seems to need an engine change, first ask: can this be solved in the consumer using existing engine data? In ~90% of cases the answer is yes.

## 6. Settings live with their owner

Per-desktop customization is owned by the desktop, edited from either iOS or the desktop's Remote settings tab, persisted on the desktop, and broadcast to every currently-paired iOS device. Offline phones pick up the latest values on their next sync snapshot. Both edit surfaces funnel through the **same main-process write helper** — exactly one persistence + broadcast path.

The engine has no opinion on user preferences. It does not persist them. It does not read them. If a setting needs to influence engine behavior, it is passed in as config at session start, not fetched by the engine from disk.

## 7. Logging is part of the contract

Logging is first-class. Every operation must be reconstructible from logs alone, without a debugger.

- Use `utils.Log` / `utils.Debug` / `utils.Error` with a consistent tag and rich context (provider id, model id, session key, request id, status codes).
- Never use `log.Printf` or `fmt.Printf` for operational logging — the desktop spawns the engine and stderr is invisible. All operational logs go to `~/.ion/engine.log` via `utils.Log`.
- Log both sides of conditionals. The happy path is as valuable as the failure path.
- When entering an under-instrumented code path, **add comprehensive logging first**, then make your change. Logging is permanent, not scaffolding.

## 8. Quality gates before declaring done

1. `cd engine && go test -race ./...` passes.
2. Public-surface changes: `go test -race -tags integration ./tests/integration/...` passes.
3. `golangci-lint run` clean.
4. `govulncheck ./...` clean.
5. `make check-file-sizes` and `make check-contracts` pass.
6. Cross-language mirrors (TS, Swift) updated if any shared type changed.
7. Never `git push`. Report changes as ready and let the user push.

## 9. File and package discipline

- 800-line cap for `*.go`, 1500 for `*_test.go`. CI hard-fails. Override only with `// @file-size-exception: <reason>` on line 1.
- Same-package multi-file is the idiom. Do not create a giant `types.go` per package (`internal/types` is the documented exception).
- Tests live next to source.
- `internal/` boundary is compiler-enforced. External consumers reach the engine only via the wire protocol.
- New code goes in a new file in the right package. Do not extend allowlisted god files (`session/manager.go`, `extension/host.go`).

## 10. House rules recap (one line each)

- Engine is headless. No UI assumptions, ever.
- Engine executes; harness decides; clients render.
- Contracts are additive only. Semantics count.
- Snapshots replace; incrementals merge. Pick one and document it.
- Engine changes are dangerous. Default to "no."
- Settings belong to the consumer that owns them.
- Log everything; success and failure; with context.
- Never `--no-verify`. Never `git push`.

---

**If anything in a task contradicts this document, surface the contradiction before writing code.**
