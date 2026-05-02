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

Cohesion of change: a feature lives in one folder. Full reference: `docs/architecture/file-organization.md`.

## Context files

- `AGENTS.md` is canonical and committed.
- `CLAUDE.md` is a local-only symlink to sibling `AGENTS.md`. Gitignored. Run `make claude-symlinks` (or `npm install` in `desktop/`) to create.
- Do not seed per-bounded-context `AGENTS.md`. Defer until traces show confusion.

## Local hooks

Run `make hooks` once per clone to point git at `.githooks/`. The pre-push hook runs `make check-file-sizes` so cap violations fail locally before reaching CI. Bypass with `--no-verify` only when intentional.

## Quality gates (must pass before merge)

| Gate | Command |
|------|---------|
| File-size cap | `make check-file-sizes` |
| Engine tests + race | `cd engine && go test -race ./...` |
| Engine integration | `cd engine && go test -race -tags integration ./tests/integration/...` |
| Engine vuln | `cd engine && govulncheck ./...` |
| Engine lint | `cd engine && golangci-lint run` |
| Relay tests + race | `cd relay && go test -race ./...` |
| Desktop typecheck | `cd desktop && npm run typecheck` |
| Desktop tests | `cd desktop && npm test` |
| Desktop audit | `cd desktop && npm audit --audit-level=high --omit=dev` |
| iOS build | `make ios-check` |

CI: `.github/workflows/build.yml` (release), `.github/workflows/quality.yml` (per-PR).

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
