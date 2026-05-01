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

- Conventional Commits, allowed types: `feat:`, `fix:`, `chore:`, `docs:`, `feat!:`.
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
