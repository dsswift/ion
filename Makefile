.PHONY: default desktop engine relay relay-local ios ios-check ios-test desktop-test engine-test test test-all test-linux test-linux-engine test-linux-desktop clean check-file-sizes check-contracts check-status-writers claude-symlinks hooks

# Homebrew installs node/npm under /opt/homebrew/bin on Apple Silicon.
# Make runs recipes with /bin/sh which only has /usr/bin:/bin in PATH,
# so node/npm are not found unless we add the Homebrew prefix here.
# The export propagates to every recipe in this Makefile.
export PATH := /opt/homebrew/bin:$(PATH)

default: engine

engine:
	@cd engine && bash commands/install.command --standalone || { echo "❌ Engine build failed"; exit 1; }

desktop:
	@$(MAKE) engine
	@cd desktop && bash commands/install-bg.command

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

test:
	@cd engine && go test ./...
	@cd desktop && npm test 2>/dev/null || true

# Run every test surface end-to-end before merging. Stops at the first
# failure so you don't waste minutes on a downstream failure that's really
# caused by an earlier component.
test-all: check-file-sizes check-contracts check-status-writers engine-test desktop-test ios-test
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
		bash -c "git config --global --add safe.directory /src && go test -race ./... && go test ./internal/types/ -run TestContractManifest"

test-linux-desktop:
	@command -v docker >/dev/null 2>&1 || { echo "❌ docker not found — install Docker/Colima to run the Linux parity gate"; exit 1; }
	@echo "▶ desktop: npm ci --ignore-scripts && npm run typecheck && npm test on linux (node:22)"
	@docker run --rm --platform linux/amd64 -v "$(PWD)":/src -w /src/desktop node:22 \
		bash -c "npm ci --ignore-scripts && npm run typecheck && npm test"

clean:
	@cd engine && rm -rf bin/ dist/
	@cd desktop && rm -rf dist/ out/

# File-architecture guardrails (see docs/architecture/file-organization.md)
check-file-sizes:
	@bash scripts/check-file-sizes.sh

# Phase 4 of the state-management overhaul. Prohibits new direct writes
# to tab.status / inst.statusFields outside the dispatcher chokepoints
# whitelisted in scripts/check-status-writers.sh.
check-status-writers:
	@bash scripts/check-status-writers.sh

# Cross-language contract drift detection.
# Asserts the Go-generated contracts.json is up to date; TS and Swift tests
# validate against it via their own test suites (npm test / xcodebuild test).
check-contracts:
	@cd engine && go test ./internal/types/ -run TestContractManifest

# Create CLAUDE.md symlinks pointing at sibling AGENTS.md files. Idempotent.
# CLAUDE.md is gitignored; AGENTS.md is committed as the canonical context file.
claude-symlinks:
	@bash scripts/setup-claude-symlinks.sh

# Point this clone's git hooks at the tracked .githooks/ directory so the
# pre-push file-size check runs before pushes hit CI. One-time per clone.
hooks:
	@git config core.hooksPath .githooks
	@echo "core.hooksPath -> .githooks"

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
