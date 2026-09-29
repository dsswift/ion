---
title: Quality Gates
description: Development-time gates, heavy PR-time gates, and why the Linux parity gate exists.
sidebar_position: 9
---

# Quality Gates

These are the gates to run **during normal development**. They are cheap, fast, and scoped to the work in front of you. Use the cadence below. Do **not** run the heavy gates listed in the next subsection while developing.

## Validation cadence — never after every file edit

Validation happens at meaningful checkpoints, not after each `Edit` or `Write` call.

1. Make a logical batch of related edits first. Format the changed files once when that batch is complete.
2. During implementation, run only the narrowest test that can disprove the behavior you just changed. Do not run typecheck, lint, file-size checks, or a broad package test after each file edit.
3. If a gate fails, fix the cause and rerun that failed gate. Do not rerun gates that already passed unless the fix could affect them.
4. When the implementation is stable, run each required development-time gate once. Run independent gates in parallel when possible.
5. After the final gate set passes, rerun a gate only when a later code change could invalidate its result. Documentation-only edits do not invalidate code gates.
6. Before commit, review the diff and working tree once. Do not use repeated omnibus gate commands as a progress check.

A successful `npm run typecheck`, lint, package test, or file-size check is reusable evidence until a relevant code change invalidates it. Repeating the same successful command without such a change is not additional verification.

| Gate | Command |
|------|---------|
| File-size cap | `make check-file-sizes` |
| Contract sync | `make check-contracts` (only when you change a shared type — see "Cross-language contract sync") |
| Status-writer check | `make check-status-writers` — run when touching code that emits `engine_status` or `engine_session_status` |
| Logging standards | `make check-logging` — enforces ADR-019: no interpolated `msg`, no `console.*` in renderer, no non-canonical field keys. |
| Engine lint | `cd engine && golangci-lint run` (scope to touched packages while iterating: `golangci-lint run ./internal/<pkg>/...`) |
| Engine tests (scoped) | `cd engine && go test ./internal/<touched-pkg>/...` — run the packages you changed, with `-race` when concurrency is involved. Do **not** routinely run the full `go test ./...` sweep while iterating. **Package scoping is not always enough:** some packages are internally slow because their tests wait on real timers (`internal/server` runs ~150s wall-clock — socket lifecycle, reap/heartbeat waits). In a known-slow package, scope further with `-run <TestPrefix>` to the arms your change touches; the package's full run happens once at PR time, not in the dev loop. |
| Desktop typecheck | `cd desktop && npm run typecheck` |
| Desktop tests (scoped) | `cd desktop && npm test -- <pattern>` for the area you touched. The full `npm test` run belongs to the pre-PR sweep. |

CI: `.github/workflows/build.yml` (release), `.github/workflows/quality.yml` (per-PR).

## Heavy gates — never run during development

The following gates are **slow** — Docker container spin-up, full-network vulnerability scan, full multi-package race runs, full iOS build. **Never run them during normal development.** Re-running them mid-session burns wall-clock and tokens for no added safety, because they run once, authoritatively, at PR time.

| Heavy gate | Command |
|------------|---------|
| Linux parity | `make test-linux` (and `make test-linux-engine` / `make test-linux-desktop`) |
| Full engine race suite | `cd engine && go test -race ./...` |
| Engine integration | `cd engine && go test -race -tags integration ./tests/integration/...` |
| Engine vuln | `cd engine && govulncheck ./...` |
| Relay tests + race | `cd relay && go test -race ./...` |
| Desktop audit | `cd desktop && npm audit --audit-level=high --omit=dev` |
| Full desktop suite | `cd desktop && npm test` |
| iOS build | `make ios-check` |

**The heavy gates run at PR time, not during development.** CI (`quality.yml`) is the authoritative gate: it runs the full set above — race suites, integration, `govulncheck`, `npm audit`, iOS build — on **every PR**, on `ubuntu-latest`. Locally, `/create-pr` runs the **Linux parity** subset (`make test-linux`, which executes the engine unit + integration race suites and the desktop lint, typecheck, and test steps inside Linux containers) **once**, right before pushing, to catch Linux-only failures before they burn Actions minutes on a red build. The only times the agent runs a heavy gate are (a) when `/create-pr` explicitly instructs it to, or (b) when the user explicitly asks for it (e.g. to reproduce a known Linux-only failure). Outside those two cases, the heavy gates are off-limits during development — CI is what proves them green on the PR.

> **Why `/create-pr` runs `make test-linux`.** Local validation runs on macOS; the blocking CI gates run on `ubuntu-latest`. `go test -race ./...` plus `go test -race -tags integration ./tests/integration/...` (the `engine-test` job), `npm run lint` (the `desktop-lint` job), and `npm test` (the `desktop-test` job) all run on Linux in CI, so a macOS-only pass is **not** sufficient — OS-sensitive failures (path semantics, file-watcher timing, locale, goroutine starvation under the Linux race detector, eager `require('electron')` under `npm ci --ignore-scripts`) slip through. `make test-linux` runs the same commands CI runs, in Linux containers, so those failures surface before the PR instead of after burning Actions minutes on a red build. `/create-pr` runs this gate automatically before pushing and pauses if Docker isn't running — the common path needs no manual step.
>
> **When a CI job that runs engine or desktop tests is added to `quality.yml`, mirror it into `make test-linux`.** The gate's value is that it is a faithful subset; a gate that claims CI parity while skipping a job green-lights the exact failures it exists to catch. Two concrete traps: integration tests are behind the `integration` build tag, so `go test ./...` silently skips them rather than failing, and `npm run typecheck` does not catch unused imports or react-hooks violations — those are ESLint rules that CI runs as a separate blocking job.

> **The gates are receipted, and the two halves run on different architectures.** A gate that already passed on the exact current HEAD with a clean worktree is skipped on the next invocation (`scripts/gate-cache.sh`; the receipt lives in git metadata, is per-worktree, and never touches the tree). Any new commit, dirty file, platform change, Dockerfile change, or edit to the gate command in the `Makefile` invalidates it. `ION_GATE_FORCE=1 make test-linux-desktop` reruns regardless. The engine gate stays pinned to `linux/amd64` to match CI, because Go race detection, memory ordering, and cgo/assembly paths are genuinely arch-sensitive. The desktop gate runs the host architecture: with `--ignore-scripts` it builds nothing native, so it is Node executing JavaScript, and the Linux-versus-macOS failures it exists to catch are properties of the kernel and libc rather than the instruction set.
