# Ion

## Layout

| Component | Path | Language |
|-----------|------|----------|
| Engine | `engine/` | Go |
| Desktop | `desktop/` | TypeScript (Electron + React) |
| Relay | `relay/` | Go |
| iOS | `ios/IonRemote/` | Swift |

Each component has its own `AGENTS.md` with subsystem-specific rules.

## File-size caps (CI hard-fails above)

| Language | Cap |
|----------|----:|
| TypeScript / TSX | 600 |
| Go (`*.go`) | 800 |
| Go (`*_test.go`) | 1500 |
| Swift | 600 |

Override: `// @file-size-exception: <reason>` (`#` for shell/yaml/python) on line 1. Existing god files allowlisted in `.file-size-allowlist.yml` — do not extend them; extract new code to a new file.

### When a file exceeds the cap

Split the file — find the natural seams (logical groupings, hook boundaries, helper clusters) and extract to a new file. **Never** remove or collapse comments, collapse whitespace, or shorten code to hit the line limit. Comments are load-bearing documentation. If the choice is between a well-commented file that is 10 lines over cap and a stripped file that is under cap, the stripped version is worse. Split instead.

Cohesion of change: a feature lives in one folder. Full reference: `docs/architecture/file-organization.md`.

## Context files

- `AGENTS.md` is canonical and committed.
- `CLAUDE.md` is a local-only symlink to sibling `AGENTS.md`. Gitignored. Run `make claude-symlinks` (or `npm install` in `desktop/`) to create.
- Do not seed per-bounded-context `AGENTS.md`. Defer until traces show confusion.
- **Before any work that touches `engine/`, read [`docs/engine-grounding.md`](docs/engine-grounding.md).** It is the non-negotiable framing for engine changes — contract stability, snapshot semantics, engine-vs-harness boundaries, and the "modifying the engine is restricted" default. Engine work without this grounding is a defect.

## Local hooks

Run `make hooks` once per clone to point git at `.githooks/`. The pre-push hook runs `make check-file-sizes` so cap violations fail locally before reaching CI. Bypass with `--no-verify` only when intentional.

## Quality gates (must pass before merge)

| Gate | Command |
|------|---------|
| File-size cap | `make check-file-sizes` |
| Contract sync | `make check-contracts` |
| Engine tests + race | `cd engine && go test -race ./...` |
| Engine integration | `cd engine && go test -race -tags integration ./tests/integration/...` |
| Engine vuln | `cd engine && govulncheck ./...` |
| Engine lint | `cd engine && golangci-lint run` (full mode on both PR and main) |
| Relay tests + race | `cd relay && go test -race ./...` |
| Desktop typecheck | `cd desktop && npm run typecheck` |
| Desktop tests | `cd desktop && npm test` |
| Desktop audit | `cd desktop && npm audit --audit-level=high --omit=dev` |
| iOS build | `make ios-check` |

CI: `.github/workflows/build.yml` (release), `.github/workflows/quality.yml` (per-PR).

## Branch workflow

- `main` is protected. All changes merge via pull request — never push directly to `main`.
- The current working branch can be any named feature branch (e.g. `josh`, `feat/foo`, `fix/bar`). Never hardcode a branch name; always use `git branch --show-current` to determine the active branch.
- **Standard flow:**
  1. Do work on the current feature branch, commit locally.
  2. When an external PR lands on `main` that your branch depends on or should incorporate: merge it on GitHub (`gh pr merge <number> --merge`), then `git checkout main && git pull` to sync local `main`, then `git checkout <feature-branch> && git rebase main` to rebase the feature branch onto the updated `main`.
  3. Open a PR from the feature branch into `main` (`gh pr create`). Never push directly to `main`.
- CI must pass on the PR before merge. Run quality gates locally first (see table below).

## Commits

- Conventional Commits with **required scope**: `type(scope): subject`.
- Allowed types: `feat`, `fix`, `chore`, `docs`, `feat!`.
- Allowed scopes (from `.commit.json`):

| Scope | Path trigger |
|-------|-------------|
| `engine` | `engine/` |
| `desktop` | `desktop/` |
| `relay` | `relay/` |
| `ios` | `ios/` |
| `docs` | `docs/` |
| `repo` | `.github/`, root files, or cross-cutting changes |

- Pick the scope matching the primary path touched. If files span multiple scopes, use the scope of the *primary* change; for pure CI/config/root changes use `repo`.
- Examples: `feat(engine): add streaming support`, `fix(desktop): correct tab order`, `chore(repo): update ci workflow`.
- Subject ≤ 50 chars, lowercase, imperative, no period.
- Never `--no-verify`.
- Never commit `.env*`, `appsettings.json`, `local.settings.json`, `engine/tests/e2e/testconfig.json`.
- Never `git push`. Tell the user the changes are ready.

## Layered architecture

| Layer | Where | Role |
|-------|-------|------|
| Engine | `engine/` (Go) | Hooks, events, tools, LLM streaming. Headless, no UI concepts. |
| Harness | `~/.ion/extensions/` (TS) | Extensions via SDK. Decides behavior. |
| Client | `desktop/`, `ios/` | Renders UI from engine events. |

Engine executes, harness decides. Engine never blocks for user input, never persists memory, never decides policy.

When labeling work: engine, harness, or client. If a harness gap is caused by missing engine capability, note both.

## Contract stability (never break the client)

The client is the consumer of the Ion engine — desktop, iOS, and harness extensions all depend on published contracts. **Never ship a breaking change to a published contract.**

Event-shape contracts are not just about field names. Event **semantics** (snapshot vs. incremental, replace vs. merge, idempotency) are also part of the contract. See [docs/architecture/agent-state.md](docs/architecture/agent-state.md) for the canonical example: `engine_agent_state` is always a complete snapshot, and consumers replace local state with the payload.

### What counts as a contract

| Surface | Key files |
|---------|-----------|
| Wire protocol | `engine/internal/protocol/protocol.go` (`ClientCommand`, `ServerMessage`, NDJSON shape) |
| NormalizedEvent variants & fields | `engine/internal/types/normalized_event.go`, mirrored in `desktop/src/shared/types.ts` and `ios/IonRemote/Models/NormalizedEvent.swift` |
| SDK types & hook signatures | `engine/internal/extension/sdk_types.go`, `sdk_hook_types.go` (`HookHandler`, `Context`, payload types) |
| Hook names & payload shapes | All hooks registered in `engine/internal/extension/sdk_hooks_*.go` |
| Engine events consumed by clients | Any event type or field a client reads to render UI |

### Allowed (non-breaking)

- **Add** new fields with zero-value defaults, new event variants, new hooks, new optional parameters.
- **Fix** bugs in existing methods (behavior change that corrects a documented or obvious defect).
- **Version** a new alternative when a design must evolve (e.g. `ToolCallV2`) — leave the original intact.

### Forbidden (breaking)

- Remove or rename a field, type, constant, hook name, or event variant.
- Change a field's type (e.g. `string` → `int`, `[]T` → `map`).
- Alter a hook's payload shape in a non-additive way.
- Remove or reorder positional arguments in an SDK callback signature.
- Change wire-protocol message framing or envelope structure.

If you believe a break is truly necessary, stop and discuss with the user — never commit it silently.

### Cross-language contract sync

Go is the source of truth. A reflection-based test (`engine/internal/types/contract_test.go`) extracts every shared struct's JSON field names into a golden manifest (`engine/internal/types/testdata/contracts.json`). TS and Swift tests validate against it.

**Workflow when you change a shared type (NormalizedEvent variant, StatusFields, EngineConfig, etc.):**

1. Make the Go change in `engine/internal/types/`.
2. Regenerate the manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`
3. Update the TS field map in `desktop/src/shared/__tests__/contract-sync.test.ts` to match.
4. Update the TS type definition in `desktop/src/shared/types-engine.ts` or `types-events.ts`.
5. Update the Swift type in `ios/IonRemote/Models/` and the Swift contract test if field coverage changed.
6. Run `make check-contracts`, `npm test`, and `make ios-check` to verify.

If you skip a step, CI fails with a clear message identifying the drift (e.g. `"Go-only: [newField]"`).

## Logging policy

Logging is a **first-class citizen** of the architecture. Every code path must be observable through logs alone.

### Rules

1. **Every operation must log.** Before execution, after success, and inside every failure branch. A developer reading logs must be able to reconstruct the exact code path from start to finish without attaching a debugger.
2. **No blind spots.** When entering existing code that lacks sufficient logging, **add comprehensive logging as the first step** before attempting any fix or feature work. This is not optional prep — it is part of the implementation.
3. **Logging is permanent.** Never treat logs as "debug scaffolding" to be removed later. Log statements ship to production. Use appropriate levels:
   - `utils.Log` / `INFO` — state transitions, resolved decisions, operation outcomes. Always present.
   - `utils.Debug` / `DEBUG` — per-request details, intermediate values, loop iterations. Verbose but useful for replay.
   - `utils.Error` / `ERROR` — unexpected failures, caught panics, invariant violations.
4. **Include context in every log.** Always log the relevant identifiers (provider ID, model ID, session key, request ID, key lengths, URL, status codes). A log line without context is useless.
5. **Log both sides of conditionals.** If an `if/else` branch makes a decision, log which branch was taken and why. Don't log only the happy path.
6. **Desktop main process** uses the `log()` helper from `../logger`. Renderer code uses `console.log` sparingly (performance-sensitive hot paths excepted).
7. **Engine Go code** uses `utils.Log(tag, msg)`, `utils.Debug(tag, msg)`, and `utils.Error(tag, msg)`. Never use `log.Printf` or `fmt.Printf` for operational logging — those go to stderr which is invisible when the desktop spawns the engine. All operational logs must go through `utils.Log` so they land in `~/.ion/engine.log`.

### Anti-patterns

- Adding a single log line per investigation cycle and hoping it's enough. **Instrument the entire code path in one pass.**
- Logging only the error case. **Log the success case too** — "operation X completed with result Y" is as valuable as "operation X failed with error Z".
- Using opaque messages like "failed" or "error occurred". **Include the what, the why, and the relevant IDs.**