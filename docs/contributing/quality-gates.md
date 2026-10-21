---
title: Quality Gates
description: Development-time gates, the heavy gates CI runs on main, and why the Linux parity gate exists.
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
| Logging standards | `make check-logging` — enforces ADR-019: no interpolated `msg`, no non-canonical field keys. |
| Engine lint | `cd engine && golangci-lint run` (scope to touched packages while iterating: `golangci-lint run ./internal/<pkg>/...`) |
| Engine tests (scoped) | `cd engine && go test ./internal/<touched-pkg>/...` — run the packages you changed, with `-race` when concurrency is involved. Do **not** run `go test -race ./...` across the whole module during development. `internal/server` takes about 150s; scope it with `-run <TestPrefix>`. |
| Go SDK tests | `cd sdk/go && go test ./...` |
| TypeScript SDK tests | `make sdk-ts-test` |
| Dashboards | `make check-dashboards` (when `docs/observability/dashboards/` changes) |
| Vocabulary | `make check-vocabulary` (when `docs/vocabulary/terms.json` changes) |
| Doc links | `make check-doc-links` (when docs change) |

CI: `.github/workflows/quality.yml` is the test lane on every push to `main` (and on pull requests); `.github/workflows/build.yml` builds and publishes releases. How they relate: [Delivery pipeline](delivery-pipeline.md).

Go micro-benchmarks run on demand with `make bench` and compare with `make bench-compare`, outside this gate and every release path.

## Heavy gates — never run during development

The following gates are **slow** — Docker container spin-up, full-network vulnerability scan, full multi-package race runs. **Never run them during normal development.** Re-running them mid-session burns wall-clock and tokens for no added safety, because CI runs them once, authoritatively, on every push to `main`.

| Heavy gate | Command |
|------------|---------|
| Linux parity | `make test-linux` |
| Full engine race suite | `cd engine && go test -race ./...` |
| Engine integration | `cd engine && go test -race -tags integration ./tests/integration/...` |
| Engine vuln | `cd engine && govulncheck ./...` |
| SDK audit | `cd engine/extensions/sdk && npm audit` |

**The heavy gates run in CI, not during development.** The test lane (`quality.yml`) runs the race suites and integration on **every push to `main`**, scoped to the paths the push touched, and files a failure as an issue; a failure keeps the releases it gates as drafts until it passes, and never blocks the push. `govulncheck` and `npm audit` run nightly in `security.yml`, off the ship path. Locally, `/create-pr` runs the **Linux parity** subset (`make test-linux`, which executes the engine unit + integration race suites and the desktop lint, typecheck, and test steps inside Linux containers) **once**, right before pushing, to catch Linux-only failures before they burn Actions minutes on a red build. The only times the agent runs a heavy gate are (a) when `/create-pr` explicitly instructs it to, or (b) when the user explicitly asks for it (e.g. to reproduce a known Linux-only failure). Outside those two cases, the heavy gates are off-limits during development — CI is what proves them green.

> **Why `/create-pr` runs `make test-linux`.** Local validation runs on macOS; the CI test lane runs on `ubuntu-latest`. `go test -race ./...` plus `go test -race -tags integration ./tests/integration/...` (the `engine-test` job) can pass on Darwin and fail on Linux: a socket path limit, a filesystem case rule, a timing window. `make test-linux` runs the engine suite in a Linux container from the same `Dockerfile` CI uses, so a green local run predicts a green CI run.
>
> **When a CI job that runs engine tests is added to `quality.yml`, mirror it into `make test-linux`.** The gate's value is that it is a faithful subset; a gate that claims CI parity while skipping a job green-lights the exact failures it exists to catch. Two concrete traps: integration tests are behind the `integration` build tag, so `go test ./...` silently skips them rather than failing, and `npm run typecheck` does not catch unused imports or react-hooks violations — those are ESLint rules that CI runs as a separate blocking job.

> **The gates are receipted, and the two halves run on different architectures.** A gate that already passed on the exact current HEAD with a clean worktree is skipped on the next invocation (`scripts/gate-cache.sh`; the receipt lives in git metadata, is per-worktree, and never touches the tree). Any new commit, dirty file, platform change, Dockerfile change, or edit to the gate command in the `Makefile` invalidates it. `ION_GATE_FORCE=1 make test-linux-desktop` reruns regardless. The engine gate stays pinned to `linux/amd64` to match CI, because Go race detection, memory ordering, and cgo/assembly paths are genuinely arch-sensitive. The desktop gate runs the host architecture: with `--ignore-scripts` it builds nothing native, so it is Node executing JavaScript, and the Linux-versus-macOS failures it exists to catch are properties of the kernel and libc rather than the instruction set.
