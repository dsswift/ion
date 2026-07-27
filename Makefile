.PHONY: default desktop desktop-pkg engine generate-dashboards relay relay-local ios ios-check ios-test desktop-test engine-test test test-all test-linux test-linux-engine test-linux-engine-summary test-linux-desktop clean check-file-sizes check-contracts check-status-writers check-atv-parity check-logging check-swiftlint check-dashboards claude-symlinks bootstrap graph graph-refresh graph-rebuild hooks lint-desktop

# Homebrew installs node/npm under /opt/homebrew/bin on Apple Silicon.
# Make runs recipes with /bin/sh which only has /usr/bin:/bin in PATH,
# so node/npm are not found unless we add the Homebrew prefix here.
# The export propagates to every recipe in this Makefile.
export PATH := /opt/homebrew/bin:$(PATH)

default: engine

engine: generate-dashboards
	@cd engine && bash commands/install.command --standalone || { echo "❌ Engine build failed"; exit 1; }

# Regenerate the provisioned Grafana dashboard JSON (+ queries.md) into the
# working tree from the canonical dashboards-as-code source. Runs on every
# `make engine` (and therefore every `make desktop`, which calls make engine).
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
	@$(MAKE) engine
	@cd desktop && bash commands/install-bg.command

# Build the macOS installer .pkg for MDM (Intune) deployment (D-003). Chains
# the electron-builder --dir build (produces release/mac*/Ion.app) into
# pkgbuild via scripts/build-pkg.sh. Does NOT install or relaunch — unlike
# `make desktop`, this only produces the artifact under desktop/release/.
desktop-pkg:
	@cd desktop && npm run dist && npm run pkg

relay:
	@cd relay && docker build --platform linux/amd64 -t ion-relay:latest .

relay-local:
	@cd relay && go run .

ios:
	@cd ios && bash commands/install.command

ios-check:
	@cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
		-destination 'generic/platform=iOS' build 2>&1 | grep -E "error:|BUILD"

# Run the IonRemoteTests unit-test bundle on a real iOS Simulator. Picks the
# newest available simulator automatically; override with the
# IOS_TEST_DESTINATION env var (see scripts/run-ios-tests.sh for format).
ios-test:
	@bash scripts/run-ios-tests.sh

# Per-component test convenience wrappers. The CI workflows already exercise
# each surface in isolation; these mirror what they do so contributors can
# run a focused check locally without remembering each toolchain's command.
engine-test:
	@cd engine && go test -race ./...

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
test-all: check-file-sizes check-contracts check-status-writers check-atv-parity check-logging check-swiftlint check-dashboards engine-test desktop-test ios-test
	@echo "✅ test-all: all surfaces green"

# ---------------------------------------------------------------------------
# Linux parity gate (run before opening a PR for engine/ or desktop/ changes)
# ---------------------------------------------------------------------------
#
# CI runs `engine-test` (go test -race) and `desktop-test` (npm test) on
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

GO_VERSION := $(shell awk '/^go / {print $$2}' engine/go.mod)

test-linux: test-linux-engine test-linux-desktop
	@echo "✅ test-linux: engine race + desktop suites green on Linux (CI parity)"

test-linux-engine:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ engine: go test -race ./... on linux/amd64 (golang:$(GO_VERSION))"
	@docker run --rm --platform linux/amd64 -v "$(PWD)":/src -w /src/engine golang:$(GO_VERSION) \
		bash -c "apt-get update -qq && apt-get install -y -qq nodejs && \
		         useradd -m -s /bin/bash ionci && \
		         chmod -R a+rX /src 2>/dev/null || true && \
		         git config --global --add safe.directory /src && \
		         su ionci -c 'mkdir -p /home/ionci/.ion /home/ionci/go /home/ionci/gocache && \
		                      git config --global --add safe.directory /src && \
		                      cd /src/engine && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test -race ./... && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test ./internal/types/ -run TestContractManifest'"

# test-linux-engine-summary runs the same suite as test-linux-engine but pipes
# output through grep so only pass/fail lines reach the terminal. Total output
# is ~40 lines regardless of suite size — useful when capturing output in a
# tool or CI step that has a small output budget. The exit code mirrors the
# underlying go test exit code: 0 on full pass, non-zero on any failure.
test-linux-engine-summary:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ engine: go test -race ./... on linux/amd64 (golang:$(GO_VERSION)) [summary]"
	@docker run --rm --platform linux/amd64 -v "$(PWD)":/src -w /src/engine golang:$(GO_VERSION) \
		bash -c "apt-get update -qq && apt-get install -y -qq nodejs && \
		         useradd -m -s /bin/bash ionci && \
		         chmod -R a+rX /src 2>/dev/null || true && \
		         git config --global --add safe.directory /src && \
		         su ionci -c 'mkdir -p /home/ionci/.ion /home/ionci/go /home/ionci/gocache && \
		                      git config --global --add safe.directory /src && \
		                      cd /src/engine && \
		                      GOPATH=/home/ionci/go GOCACHE=/home/ionci/gocache \
		                      go test -race ./... 2>&1 | grep -E \"^(ok|FAIL|--- FAIL|--- PASS)\"; \
		                      exit \$${PIPESTATUS[0]}'"

test-linux-desktop:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ desktop: npm ci --ignore-scripts && npm run typecheck && npm test on linux (node:22)"
	@docker run --rm --platform linux/amd64 -v "$(PWD)":/src -v /src/desktop/node_modules -w /src/desktop node:22 \
		bash -c "useradd -m -s /bin/bash ionci && \
		         chmod -R a+rX /src 2>/dev/null || true && \
		         chown ionci:ionci /src/desktop/node_modules && \
		         su ionci -c 'cd /src/desktop && npm ci --ignore-scripts && npm run typecheck && npm test'"

clean:
	@cd engine && rm -rf bin/ dist/
	@cd desktop && rm -rf dist/ out/

# File-architecture guardrails (see docs/architecture/file-organization.md)
check-file-sizes:
	@bash scripts/check-file-sizes.sh

# Dashboards-as-code drift + structural-overcount gate. Regenerates every
# provisioned Grafana dashboard JSON and queries.md from the canonical query
# module and byte-diffs against the committed files; also re-runs the
# range-accumulation-fixed-window audit on emitted JSON. See
# docs/observability/dashboards and ADR-020. Zero runtime deps (Node native
# TypeScript type-stripping) — no npm install needed.
check-dashboards:
	@node docs/observability/dashboards/src/check.ts

# Phase 4 of the state-management overhaul. Prohibits new direct writes
# to tab.status / inst.statusFields outside the dispatcher chokepoints
# whitelisted in scripts/check-status-writers.sh.
check-status-writers:
	@bash scripts/check-status-writers.sh

# Overlay↔ATV broadcast parity: event pushes to the overlay renderer must
# route through broadcast() (which fans out to the ATV mirror) unless the
# file is on the owner-only allowlist in scripts/check-atv-parity.sh.
check-atv-parity:
	@bash scripts/check-atv-parity.sh

# Cross-language contract drift detection.
# Asserts the Go-generated contracts.json is up to date; TS and Swift tests
# validate against it via their own test suites (npm test / xcodebuild test).
check-contracts:
	@cd engine && go test ./internal/types/ -run TestContractManifest

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
	@$(MAKE) --no-print-directory graph
	@echo "✅ bootstrap complete"

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
# graph; `make graph-rebuild` discards it and extracts from scratch. Reach for
# refresh when you suspect the graph missed something, and rebuild to purge
# nodes that repeated incremental updates have left stale.
#
# A missing graphify install is a notice, never a failure: the graph is an
# optional developer convenience and bootstrap must not break over it.
graph:
	@if [ -f graphify-out/graph.json ]; then \
		echo "▶ graphify: graph already present, skipping build (use 'make graph-refresh' or 'make graph-rebuild')"; \
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
	@if ! command -v graphify >/dev/null 2>&1; then \
		echo "⚠️  graphify not on PATH — nothing to refresh."; \
	elif [ ! -f graphify-out/graph.json ]; then \
		echo "▶ graphify: no graph yet — building instead"; \
		$(MAKE) --no-print-directory graph; \
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
graph-rebuild:
	@if ! command -v graphify >/dev/null 2>&1; then \
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
