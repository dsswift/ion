.PHONY: sync-windows-vm default demo desktop desktop-pkg engine generate-dashboards relay relay-local ios ios-check ios-test desktop-test engine-test sdk-test test test-all test-linux test-linux-engine test-linux-engine-run test-linux-engine-summary test-linux-desktop test-linux-desktop-run clean check-file-sizes check-contracts check-status-writers check-studio-parity check-logging check-admx check-windows-scripts check-swiftlint check-dashboards check-vocabulary check-issue-closure generate-vocabulary claude-symlinks bootstrap graph graph-ensure graph-refresh hooks lint-desktop log-level-debug

# Homebrew installs node/npm under /opt/homebrew/bin on Apple Silicon.
# Make runs recipes with /bin/sh which only has /usr/bin:/bin in PATH,
# so node/npm are not found unless we add the Homebrew prefix here.
# The export propagates to every recipe in this Makefile.
export PATH := /opt/homebrew/bin:$(PATH)

default: engine

engine: generate-dashboards
	@cd engine && bash commands/install.command --standalone || { echo "❌ Engine build failed"; exit 1; }

# Regenerate the provisioned Grafana dashboard JSON (+ queries.md) into the
# working tree when `make engine` runs.
#
# Why regenerate on build: the local docker-compose Grafana bind-mounts
# ./grafana/provisioning directly and its dashboards provider reloads every
# 30s (updateIntervalSeconds: 30 in dashboards.yaml). Emitting the JSON into
# the tree on build means a local `docker compose up -d` Grafana auto-picks-up
# dashboard changes with no manual `npm run generate` step, and any resulting
# drift is immediately visible/committable in `git status`.
#
# SOFT STEP — never blocks the engine build. If Node is missing or generation
# errors, we print a skip notice and continue. `make check-dashboards` remains
# the HARD drift gate (CI + pre-push): this target only writes, it does not
# verify. The `|| true` cannot mask a real drift regression because the gate,
# not this step, is what fails the build on drift.
generate-dashboards:
	@command -v node >/dev/null 2>&1 || { echo "⚠️  dashboards: node not found — skipping dashboard generation (make check-dashboards still gates drift in CI)"; exit 0; }
	@node docs/observability/dashboards/src/generate.ts >/dev/null 2>&1 \
		&& echo "✅ dashboards: regenerated provisioned JSON into docs/observability/grafana/provisioning/dashboards/" \
		|| echo "⚠️  dashboards: generation failed — continuing engine build (make check-dashboards still gates drift in CI)"

desktop:
	@cd desktop && bash commands/install-bg.command

# Build the macOS installer .pkg for MDM (Intune) deployment (D-003). Chains
# the electron-builder --dir build (produces release/mac*/Ion.app) into
# pkgbuild via scripts/build-pkg.sh. Does NOT install or relaunch — unlike
# `make desktop`, this only produces the artifact under desktop/release/.
desktop-pkg:
	@cd desktop && npm run dist && npm run pkg

# Push this checkout's tracked source to a Windows test VM.
#
# Only relevant while a Windows VM is open for testing; ordinary macOS work
# never needs it. Ships every tracked file under engine/, desktop/, packaging/
# and scripts/ as one archive rather than a hand-picked diff, because a
# per-file copy left the VM's tree missing files and produced two false
# "still broken" retests against a stale binary.
#
# Override the target with ION_WIN_VM_HOST / ION_WIN_VM_PATH.
sync-windows-vm:
	@bash scripts/sync-windows-vm.sh

# Build the Windows NSIS installer for local testing (windows-mvp program).
# Produces desktop/release/Ion-Setup-<version>-x64.exe. Windows-only —
# electron-builder's NSIS target requires the win32 host toolchain.
desktop-win:
	@cd desktop && npm run dist:win

relay:
	@cd relay && docker build --platform linux/amd64 -t ion-relay:latest .

relay-local:
	@cd relay && go run .

ios:
	@cd ios && bash commands/install.command

ios-check:
	@cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
		-destination 'generic/platform=iOS' build 2>&1 | grep -E "error:|BUILD"

# Required iOS PR gate. Device-target compilation catches Swift, link, and
# packaging errors without booting a simulator. Full IonRemoteTests belongs to
# the scheduled/manual CI lane because hosted simulator startup is costly.
ios-pr-check:
	@cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
		-destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build

# Run the IonRemoteTests unit-test bundle on a real iOS Simulator. Picks the
# newest available simulator automatically; override with the
# IOS_TEST_DESTINATION env var (see scripts/run-ios-tests.sh for format).
ios-test:
	@bash scripts/ios-test-retry.test.sh
	@bash scripts/run-ios-tests.sh

# Per-component test convenience wrappers. The CI workflows already exercise
# each surface in isolation; these mirror what they do so contributors can
# run a focused check locally without remembering each toolchain's command.
engine-test:
	@cd engine && go test -race ./...

# The Go SDK module. Its parity tests read the engine's generated contract
# manifest and its own surface manifest, so they run from a full checkout —
# this is the target that fails when the two SDKs drift apart.
sdk-test:
	@cd sdk/go && go test -race ./...

desktop-test:
	@cd desktop && npm test

lint-desktop:
	@cd desktop && npm run lint

test:
	@cd engine && go test ./...
	@cd desktop && npm test 2>/dev/null || true

# Run every test surface end-to-end before merging. Stops at the first
# failure so you don't waste minutes on a downstream failure that's really
# caused by an earlier component.
test-all: check-file-sizes check-contracts check-status-writers check-studio-parity check-logging check-swiftlint check-dashboards check-vocabulary engine-test sdk-test desktop-test ios-test
	@echo "✅ test-all: all surfaces green"

# ---------------------------------------------------------------------------
# Linux parity gate (run before opening a PR for engine/ or desktop/ changes)
# ---------------------------------------------------------------------------
#
# CI runs `engine-test` (unit race + contract manifest + integration race) and
# `desktop-lint` / `desktop-test` (ESLint, typecheck, npm test) on
# ubuntu-latest. macOS-only local runs miss OS-sensitive failures: path
# semantics, file-watcher timing, locale, and goroutine starvation under the
# Linux race detector. These targets run the SAME commands CI runs, in Linux
# containers, so a contributor on macOS can catch a Linux-only failure before
# it reaches the PR.
#
# Requirements: Docker (or Colima) running. If Docker is absent these targets
# fail with a clear message rather than silently passing.
#
# Implementation notes (learned the hard way):
#   - Mount the FULL repo (-v "$(PWD)":/src), not a subdirectory. Mounting only
#     engine/ or desktop/ strips the repo-root .git (breaks gitcontext tests)
#     and breaks cross-tree imports (desktop SDK tests import ../../engine/...,
#     contract-sync reads engine/internal/types/testdata/contracts.json).
#   - Pin the Go image to the version in engine/go.mod (single source of truth).
#   - `git config --global --add safe.directory` is required because the mounted
#     tree is owned by the host user, not the container user.
#   - Desktop uses `npm ci --ignore-scripts`, exactly as CI does — this is what
#     surfaces eager-`require('electron')` import failures.
#   - Integration tests need `-tags integration`. They are behind a build tag,
#     so `go test ./...` silently skips them: the files never compile and a
#     stale assertion in tests/integration/ passes the gate and fails CI.
#   - Desktop lint must run here too. `npm run typecheck` does NOT catch unused
#     imports or react-hooks violations — those are ESLint rules, and CI runs
#     them as a separate blocking job. Typecheck alone is not a substitute.
#   - The engine/desktop images are prebaked (scripts/docker/*.Dockerfile) and
#     Go module/build + npm caches ride named Docker volumes, so a repeat run
#     skips both the `apt-get install nodejs`/`useradd` setup and a from-zero
#     module download + full `-race` recompile. See the comment above
#     ENGINE_IMAGE/DESKTOP_IMAGE below for the full rationale.
#
# When a job is added to .github/workflows/quality.yml that runs engine or
# desktop tests, mirror it here. A gate that claims CI parity while running a
# subset is worse than no gate: it green-lights the exact failures it is
# supposed to catch.

# Match actions/setup-go's go-version-file behavior: prefer the exact toolchain
# directive used by CI and release builds, with the language version as fallback.
GO_VERSION := $(shell awk '/^toolchain go/ {sub(/^toolchain go/, ""); print; found=1; exit} /^go / && !fallback {fallback=$$2} END {if (!found) print fallback}' engine/go.mod)

# Prebaked-image + named-volume plumbing for the Linux parity gate.
#
# Two independent, compounding speedups over a stock `golang:$(GO_VERSION)` /
# `node:22` container:
#
#  1. Prebaked images (scripts/docker/*.Dockerfile) bake in `nodejs` /
#     `useradd ionci`, which previously ran fresh on every single invocation.
#     `docker build` is called before every run, pointed at a source-free
#     build context (scripts/docker/ only — no repo COPY), so Docker's own
#     layer cache makes a rebuild an instant no-op except when the Dockerfile
#     or base image tag actually changes.
#  2. Named volumes (ion-golang-mod-cache, ion-golang-build-cache,
#     ion-npm-cache) persist the Go module cache, Go build cache, and npm
#     download cache across runs, instead of starting from zero inside a
#     fresh `--rm` container every time. `node_modules` itself stays an
#     anonymous per-run volume deliberately: a *named* volume there would
#     persist a stale/incompatible install across dependency changes, where
#     only the npm download cache benefits from persistence.
#
# Both are pure execution-speed changes — `make test-linux-engine` /
# `make test-linux-desktop` / `make test-linux` keep their existing names and
# pass/fail semantics, so no other caller needs to change.
# Platform selection. The engine gate stays pinned to linux/amd64: CI runs on
# ubuntu-latest, and Go race detection, memory ordering, and any assembly or
# cgo path are genuinely architecture-sensitive, so matching CI's arch is part
# of what that gate buys.
#
# The desktop gate is not. Its whole command (see test-linux-desktop-run) is
# `npm ci --ignore-scripts && eslint && tsc && vitest` — with scripts ignored
# nothing native is ever built, so it is Node executing JavaScript. What the
# gate exists to catch is Linux-versus-macOS (path semantics, inotify timing,
# locale, eager electron requires under --ignore-scripts), and every one of
# those is a property of the kernel and libc rather than the instruction set.
# Emulating amd64 for it on an ARM host taxed every instruction to re-verify
# something the host arch already proves, so the desktop gate runs native.
#
# --platform is still passed explicitly rather than left to Docker's default,
# because DOCKER_DEFAULT_PLATFORM in the environment would otherwise silently
# put the emulation back.
HOST_ARCH := $(shell uname -m)
ifeq ($(filter $(HOST_ARCH),arm64 aarch64),)
DESKTOP_ARCH := amd64
else
DESKTOP_ARCH := arm64
endif
ENGINE_PLATFORM := linux/amd64
DESKTOP_PLATFORM := linux/$(DESKTOP_ARCH)

# The desktop tag carries its arch so a native image can never be confused
# with an emulated one left behind by an earlier run.
ENGINE_IMAGE := ion-test-linux-engine:$(GO_VERSION)
DESKTOP_IMAGE := ion-test-linux-desktop:22-$(DESKTOP_ARCH)

# Linked-worktree support: a git worktree's .git is a *file* pointing at an
# absolute host path under the base repo's .git/worktrees/<name>, which lives
# outside $(PWD) and therefore outside the bind-mounted /src. Without an extra
# mount at that same host path, every git invocation inside the container
# (gitcontext tests shell out to real `git`; the gate itself needs
# `git status`/`git diff` to work) fails with "fatal: not a git repository".
# `git rev-parse --path-format=absolute --git-common-dir` resolves the real
# .git for both a normal checkout (where it equals $(PWD)/.git — no extra
# mount needed) and a linked worktree (where it's the base repo's .git — the
# case this exists to fix). Mounting it at the SAME path inside the container
# is what lets git's relative "gitdir: ../../.git/worktrees/<name>" pointer
# resolve correctly on both sides.
GIT_COMMON_DIR := $(shell git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
ifeq ($(GIT_COMMON_DIR),$(PWD)/.git)
GIT_WORKTREE_MOUNT :=
else ifeq ($(GIT_COMMON_DIR),)
GIT_WORKTREE_MOUNT :=
else
GIT_WORKTREE_MOUNT := -v "$(GIT_COMMON_DIR)":"$(GIT_COMMON_DIR)"
endif

test-linux: test-linux-engine test-linux-desktop
	@echo "✅ test-linux: engine unit+integration race, desktop lint+typecheck+test green on Linux (CI parity)"

test-linux-engine:
	@bash scripts/gate-cache.sh check engine $(ENGINE_PLATFORM) || $(MAKE) --no-print-directory test-linux-engine-run

test-linux-engine-run:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ engine: building prebaked Linux parity image ($(ENGINE_IMAGE))"
	@docker build --platform $(ENGINE_PLATFORM) --build-arg GO_VERSION=$(GO_VERSION) \
		-t $(ENGINE_IMAGE) -f scripts/docker/test-linux-engine.Dockerfile scripts/docker
	@echo "▶ engine: go test -race ./... + integration on linux/amd64 ($(ENGINE_IMAGE))"
	@docker run --rm --platform $(ENGINE_PLATFORM) -v "$(PWD)":/src $(GIT_WORKTREE_MOUNT) \
		-v ion-golang-mod-cache:/home/ionci/go -v ion-golang-build-cache:/home/ionci/gocache \
		-w /src/engine $(ENGINE_IMAGE) \
		bash -c "chmod -R a+rX /src 2>/dev/null || true && \
		         git config --global --add safe.directory /src && \
		         su ionci -c 'git config --global --add safe.directory /src && \
		                      git config --global --add safe.directory \"$(GIT_COMMON_DIR)\" && \
		                      cd /src/engine && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test -race ./... && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test ./internal/types/ -run TestContractManifest && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test ./internal/extension/ -run TestSDKContractManifest && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test -race -tags integration ./tests/integration/... && \
		                      cd /src/sdk/go && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test -race ./...'"
	@bash scripts/gate-cache.sh save engine $(ENGINE_PLATFORM)

# test-linux-engine-summary runs the same suite as test-linux-engine but pipes
# output through grep so only pass/fail lines reach the terminal. Total output
# is ~40 lines regardless of suite size — useful when capturing output in a
# tool or CI step that has a small output budget. The exit code mirrors the
# underlying go test exit code: 0 on full pass, non-zero on any failure.
test-linux-engine-summary:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ engine: building prebaked Linux parity image ($(ENGINE_IMAGE))"
	@docker build --platform $(ENGINE_PLATFORM) --build-arg GO_VERSION=$(GO_VERSION) \
		-t $(ENGINE_IMAGE) -f scripts/docker/test-linux-engine.Dockerfile scripts/docker
	@echo "▶ engine: go test -race ./... on linux/amd64 ($(ENGINE_IMAGE)) [summary]"
	@docker run --rm --platform $(ENGINE_PLATFORM) -v "$(PWD)":/src $(GIT_WORKTREE_MOUNT) \
		-v ion-golang-mod-cache:/home/ionci/go -v ion-golang-build-cache:/home/ionci/gocache \
		-w /src/engine $(ENGINE_IMAGE) \
		bash -c "chmod -R a+rX /src 2>/dev/null || true && \
		         git config --global --add safe.directory /src && \
		         su ionci -c 'git config --global --add safe.directory /src && \
		                      git config --global --add safe.directory \"$(GIT_COMMON_DIR)\" && \
		                      cd /src/engine && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test -race ./... 2>&1 | grep -E \"^(ok|FAIL|--- FAIL|--- PASS)\"; \
		                      exit \$${PIPESTATUS[0]}'"

test-linux-desktop:
	@bash scripts/gate-cache.sh check desktop $(DESKTOP_PLATFORM) || $(MAKE) --no-print-directory test-linux-desktop-run

test-linux-desktop-run:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ desktop: building prebaked Linux parity image ($(DESKTOP_IMAGE))"
	@docker build --platform $(DESKTOP_PLATFORM) -t $(DESKTOP_IMAGE) -f scripts/docker/test-linux-desktop.Dockerfile scripts/docker
	@echo "▶ desktop: npm ci --ignore-scripts && npm run lint && npm run typecheck && npm test on linux ($(DESKTOP_IMAGE))"
	@docker run --rm --platform $(DESKTOP_PLATFORM) -v "$(PWD)":/src -v /src/desktop/node_modules $(GIT_WORKTREE_MOUNT) \
		-v ion-npm-cache:/home/ionci/.npm \
		-w /src/desktop $(DESKTOP_IMAGE) \
		bash -c "chmod -R a+rX /src 2>/dev/null || true && \
		         chown ionci:ionci /src/desktop/node_modules && \
		         git config --global --add safe.directory /src && \
		         git config --global --add safe.directory \"$(GIT_COMMON_DIR)\" && \
		         su ionci -c 'cd /src/desktop && npm ci --ignore-scripts && npm run lint && npm run typecheck && npm test'"
	@bash scripts/gate-cache.sh save desktop $(DESKTOP_PLATFORM)

clean:
	@cd engine && rm -rf bin/ dist/
	@cd desktop && rm -rf dist/ out/

# The local conversation pipeline sample (samples/conversation-pipeline).
# Build targets stay pure at this level; the sample's operations live one
# layer down and are reached as `make demo <verb> [<verb>...]`, e.g.
#   make demo up
#   make demo run
#   make demo transcript CONV=<conversation id>
#   make demo fold HOT_WINDOW=2m
# The verbs are forwarded, in order, to the sample's own Makefile, which is
# the source of truth for what each does (`make demo` alone prints them).
# Variables given on the command line (CONV=, HOT_WINDOW=) reach it too.
DEMO_VERBS := help build check up down reset status logs seed list transcript fold run checkpoints
ifneq ($(filter demo,$(MAKECMDGOALS)),)
  DEMO_ARGS := $(filter-out demo,$(MAKECMDGOALS))
  DEMO_UNKNOWN := $(filter-out $(DEMO_VERBS),$(DEMO_ARGS))
  ifneq ($(DEMO_UNKNOWN),)
    $(error make demo: unknown verb(s) "$(DEMO_UNKNOWN)"; choose from: $(DEMO_VERBS))
  endif
  # Each verb becomes a no-op goal here so make does not look for it at
  # this level; the sample's Makefile runs the real target.
  $(foreach v,$(DEMO_ARGS),$(eval $(v): ; @:))
  .PHONY: $(DEMO_ARGS)
endif

demo:
	@$(MAKE) --no-print-directory -C samples/conversation-pipeline $(if $(DEMO_ARGS),$(DEMO_ARGS),help)

# File-architecture guardrails (see docs/architecture/file-organization.md)
check-file-sizes:
	@bash scripts/check-file-sizes.sh

# Compiled executables must never be tracked. An ignore rule only covers paths
# someone anticipated; this checks what is actually in the index.
.PHONY: check-no-binaries
check-no-binaries:
	@bash scripts/check-no-binaries.sh

# Dashboards-as-code drift + structural-overcount gate. Regenerates every
# provisioned Grafana dashboard JSON and queries.md from the canonical query
# module and byte-diffs against the committed files; also re-runs the
# range-accumulation-fixed-window audit on emitted JSON. See
# docs/observability/dashboards and ADR-020. Zero runtime deps (Node native
# TypeScript type-stripping) — no npm install needed.
check-dashboards:
	@node docs/observability/dashboards/src/check.ts

# Vocabulary registry validation and generated-index drift gate.
# Fix failures with `make generate-vocabulary` after correcting the registry.
check-vocabulary:
	@node --test scripts/vocabulary.test.mjs
	@node scripts/vocabulary.mjs check

# Regenerate the committed vocabulary index from its machine-validated registry. Use this after changing docs/vocabulary/terms.json.
generate-vocabulary:
	@node scripts/vocabulary.mjs generate

# Verifies every issue a PR's title/commits reference as "(#N)" actually
# closes on merge (a real "Fixes #N"/"Closes #N" keyword, not just the link
# suffix). Pass PR=<number>, or omit to resolve the current branch's PR.
check-issue-closure:
	@bash scripts/check-issue-closure.sh $(PR)

# Phase 4 of the state-management overhaul. Prohibits new direct writes
# to tab.status / inst.statusFields outside the dispatcher chokepoints
# whitelisted in scripts/check-status-writers.sh.
check-status-writers:
	@bash scripts/check-status-writers.sh

# Overlay↔Studio broadcast parity: event pushes to the overlay renderer must
# route through broadcast() (which fans out to the Studio mirror) unless the
# file is on the owner-only allowlist in scripts/check-studio-parity.sh.
check-studio-parity:
	@bash scripts/check-studio-parity.sh

# Cross-language contract drift detection.
# Asserts the Go-generated contracts.json is up to date; TS and Swift tests
# validate against it via their own test suites (npm test / xcodebuild test).
check-contracts:
	@cd engine && go test ./internal/types/ -run TestContractManifest
	@cd engine && go test ./internal/extension/ -run TestSDKContractManifest

# Windows Group Policy template gate.
# Cross-checks packaging/windows/policy/IonEngine.admx against its en-US ADML
# (every $(string.*)/$(presentation.*) reference resolves, every element has a
# presentation control) and against docs/enterprise/mdm.md (every registry
# value name the template writes is documented). Runs the validator's own
# regression suite too, so a broken validator cannot pass silently.
# The Windows entry points (bootstrap.ps1, make.ps1) have no Makefile to guard
# them, and a PowerShell syntax error only surfaces when the script runs -- on
# Windows, usually on someone else's machine.
check-windows-scripts:
	@bash scripts/ci/validate-powershell.sh

check-admx:
	@python3 scripts/ci/validate-admx.py
	@bash scripts/ci/validate-admx.test.sh

# ADR-019 logging-standards enforcement gate.
# Scans emitter call sites for interpolated messages, console.* in the renderer,
# relay slog package-level calls that bypass relayHandler, and non-canonical
# field keys. See scripts/check-logging.sh for the full check catalog.
check-logging:
	@bash scripts/check-logging.sh

# Silent-failure gate for the iOS app (mirrors check-logging's "no silent
# failures" goal). Custom SwiftLint rules flag empty `catch {}` blocks
# (error — swallows the error) and silent `try?` statements (warning). Only
# the empty-catch error fails the build; the try? warnings are advisory. We
# deliberately do NOT pass --strict: --strict escalates every warning to an
# error, which would fail the build on the 100+ legitimate try? sites this
# gate intentionally leaves as warnings. Plain `swiftlint lint` exits non-zero
# only on error-severity violations, which is exactly the gate we want.
# No-ops gracefully (exit 0) when swiftlint is not installed so contributors
# without it are not blocked locally; CI has it pinned.
check-swiftlint:
	@if ! command -v swiftlint >/dev/null 2>&1; then \
		echo "check-swiftlint: swiftlint not installed — skipping (CI enforces this gate). Install: brew install swiftlint"; \
		exit 0; \
	fi
	@swiftlint lint --config ios/.swiftlint.yml ios/IonRemote

# Create CLAUDE.md symlinks pointing at sibling AGENTS.md files. Idempotent.
# CLAUDE.md is gitignored; AGENTS.md is committed as the canonical context file.
claude-symlinks:
	@bash scripts/setup-claude-symlinks.sh

# One-command setup for a fresh clone. Idempotent — safe to re-run.
#
# Two things a clone cannot carry:
#
#  1. core.hooksPath. `npm install` runs the root `prepare` script, which runs
#     husky: it generates .husky/_ and points core.hooksPath at it, activating
#     the tracked pre-push, commit-msg, and graphify rebuild hooks. That config
#     is per-clone git state, never cloned, which is why this step exists.
#  2. graphify-out/. The knowledge graph is a gitignored local build cache, so
#     a fresh clone has none and builds it once here.
#
# The graphify skill (.ion/skills/) and the project engine.json (.ion/) ARE
# tracked, so they arrive with the clone and need nothing.
bootstrap:
	@echo "▶ npm install (husky hooks)"
	@npm install --silent
	@$(MAKE) --no-print-directory claude-symlinks
	@$(MAKE) --no-print-directory log-level-debug
	@$(MAKE) --no-print-directory graph-ensure
	@echo "✅ bootstrap complete"

# Put the developer's engine into DEBUG.
#
# Running bootstrap means developing Ion, and the global engine at ~/.ion is
# the dev build being tested. DEBUG is the level that build needs; a consumer
# install stays on INFO, which is why this lives in bootstrap and not in the
# shipped defaults. logLevel resolves once at daemon start from the global
# config alone, so a project-level .ion/engine.json cannot raise it.
log-level-debug:
	@bash scripts/bootstrap-log-level.sh

# Build the graphify knowledge graph if this clone has none.
#
# Two stages, because `extract` alone leaves the graph half-built:
#
#  1. `graphify . --code-only` extracts nodes and edges. Offline and free —
#     code extraction is pure local tree-sitter, and --code-only skips the
#     docs/PDFs/images that would otherwise need an LLM backend (under 2% of
#     nodes in this repo). Queries work after this stage.
#  2. `graphify cluster-only . --no-label` partitions the graph into
#     communities (Leiden) and writes GRAPH_REPORT.md. Without it, query
#     results carry no community field and there is no readable report.
#
# --no-label is deliberate: community *partitioning* is offline, but community
# *naming* calls an LLM backend. --no-label keeps the whole build key-free and
# leaves honest "Community N" placeholders. To get descriptive names later
# (e.g. "Plan Mode Prompt Builder"), run `graphify label` with a backend
# configured — an opt-in cost, never part of bootstrap.
#
# Idempotent by design: an existing graph.json short-circuits both stages, so
# re-running `make bootstrap` never re-extracts. The hooks keep the graph
# current from then on — post-commit for your own commits, post-checkout for
# branch switches, and Ion's own post-merge / post-rewrite for pulls and
# rebases (see scripts/graphify-rebuild.sh).
#
# `make graph-refresh` forces an incremental re-extraction against the existing
# graph; `make graph` discards it and extracts from scratch. Reach for refresh
# when you suspect the graph missed something, and `make graph` to purge nodes
# that repeated incremental updates have left stale.
#
# This target (`graph-ensure`) is the bootstrap-only build-if-absent path; the
# deliberately awkward name keeps `make graph` free for the thing a developer
# actually means when they type it.
#
# A missing graphify install is a notice, never a failure: the graph is an
# optional developer convenience and bootstrap must not break over it.
#
# Linked worktrees query a primary-owned graph.json link. Hooks skip them, and
# graph-ensure remains a successful bootstrap no-op. graph-refresh is an
# idempotent compatibility bridge for older manifests: it creates or validates
# the link but never rebuilds. graph refuses in a linked worktree.
graph-ensure:
	@guard="$$(bash scripts/graphify-worktree-guard.sh)" || exit $$?; \
	if [ "$${guard%% *}" = "worktree" ]; then \
		echo "▶ graphify: linked worktree — skipping graph build (primary graph is provisioned for queries)"; \
	elif [ -f graphify-out/graph.json ]; then \
		echo "▶ graphify: graph already present, skipping build (use 'make graph-refresh' or 'make graph')"; \
	elif ! command -v graphify >/dev/null 2>&1; then \
		echo "⚠️  graphify not on PATH — skipping graph build."; \
		echo "   Install with 'uv tool install graphifyy' (or 'pipx install graphifyy'), then re-run 'make bootstrap'."; \
	else \
		echo "▶ graphify: extracting the knowledge graph (offline, no API key)"; \
		graphify . --code-only; \
		echo "▶ graphify: clustering + report"; \
		graphify cluster-only . --no-viz --no-label; \
	fi

# Incrementally re-extract new and changed files into the existing graph.
# This is the same operation the hooks perform, run on demand — useful when a
# rebuild was skipped (GRAPHIFY_SKIP_HOOK) or you want to be certain the graph
# reflects the working tree before a long investigation.
#
# The whole recipe is one shell so the missing-graphify branch actually skips
# the work. A `command -v ... || { echo; exit 0; }` guard on its own recipe
# line only exits that line's sub-shell — make proceeds to the next line and
# runs the refresh anyway, ending with a 127. Notice, never a failure.
#
# `graphify update` is the code-only incremental path by definition ("no LLM
# needed") and rejects --code-only as an unknown option. It routes through the
# same watch-rebuild code the git hooks use, which takes the per-repo flock —
# so a refresh racing a hook rebuild cannot lose an update.
graph-refresh:
	@guard="$$(bash scripts/graphify-worktree-guard.sh)" || exit $$?; \
	if [ "$${guard%% *}" = "worktree" ]; then \
		primary="$${guard#* }/graphify-out/graph.json"; local="graphify-out/graph.json"; \
		if [ ! -f "$$primary" ]; then \
			echo "▶ graphify: primary checkout has no graph; worktree link remains absent"; \
		elif [ -L "$$local" ] && [ "$$(readlink "$$local" | sed 's/\\\\/\//g')" = "$$primary" ]; then \
			echo "▶ graphify: primary graph link already present"; \
		elif [ -e "$$local" ] || [ -L "$$local" ]; then \
			echo "Refused: $$local exists but is not the primary graph link; refusing to replace local data." >&2; \
			exit 1; \
		else \
			mkdir -p graphify-out; ln -s "$$primary" "$$local"; \
			echo "▶ graphify: linked primary graph for worktree queries"; \
		fi; \
	elif ! command -v graphify >/dev/null 2>&1; then \
		echo "⚠️  graphify not on PATH — nothing to refresh."; \
	elif [ ! -f graphify-out/graph.json ]; then \
		echo "▶ graphify: no graph yet — building instead"; \
		$(MAKE) --no-print-directory graph-ensure; \
	else \
		echo "▶ graphify: incremental refresh (offline, no API key)"; \
		graphify update .; \
	fi

# Discard the graph and extract from scratch. Incremental updates accumulate
# stale nodes for files that leave the scan corpus, and only a full extraction
# purges them. Offline and key-free, same as the bootstrap build.
#
# The existing graph is moved aside rather than deleted, and restored if the
# rebuild fails. Deleting first means a failed extraction (no graphify, no
# disk, interrupted run) leaves the clone with no graph at all — strictly
# worse than the stale one it had, and a full re-extraction is not cheap.
graph:
	@guard="$$(bash scripts/graphify-worktree-guard.sh)" || exit $$?; \
	if [ "$${guard%% *}" = "worktree" ]; then \
		echo "Refused: graph rebuild belongs in primary checkout $${guard#* }. This worktree reads its provisioned graph.json link." >&2; \
		exit 1; \
	elif ! command -v graphify >/dev/null 2>&1; then \
		echo "⚠️  graphify not on PATH — nothing to rebuild."; \
	else \
		echo "▶ graphify: rebuilding from scratch"; \
		rm -rf graphify-out.bak; \
		if [ -d graphify-out ]; then mv graphify-out graphify-out.bak; fi; \
		if graphify . --code-only && graphify cluster-only . --no-viz --no-label; then \
			rm -rf graphify-out.bak; \
			echo "▶ graphify: rebuild complete"; \
		else \
			echo "⚠️  graphify: rebuild failed — restoring the previous graph."; \
			rm -rf graphify-out; \
			if [ -d graphify-out.bak ]; then mv graphify-out.bak graphify-out; fi; \
			exit 1; \
		fi; \
	fi

# Repair this clone's git hooks when core.hooksPath has drifted. Husky owns
# the hook system: root `package.json` has `"prepare": "husky"`, so a plain
# `npm install` already points core.hooksPath at `.husky/_`. This target only
# exists to fix a clone where that config was manually overridden.
hooks:
	@git config core.hooksPath .husky/_
	@echo "core.hooksPath -> .husky/_"

# Local pipeline testing (requires: brew install act)
test-pipeline-dry:
	act workflow_dispatch -W .github/workflows/build.yml \
		--input release_report="$$(cat .act/release-report.json)" \
		--dryrun

test-pipeline-engine:
	act workflow_dispatch -W .github/workflows/build.yml \
		-j build-engine \
		--input release_report="$$(cat .act/release-report.json)"

test-pipeline-relay:
	act workflow_dispatch -W .github/workflows/build.yml \
		-j build-relay \
		--input release_report="$$(cat .act/release-report.json)"
