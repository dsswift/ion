---
title: Branch Protection
description: GitHub branch protection settings for the Ion repository.
sidebar_position: 7
---

# Branch Protection

The `main` branch is protected via a GitHub repository ruleset. These settings live in the GitHub UI (Settings → Rules → Rulesets), not in code. This document records the configuration so it is reproducible and discoverable.

## Ruleset: main

**Target:** `main` branch

### Required status checks

All Quality workflow jobs must pass before a PR can merge:

| Check name | Workflow |
|------------|----------|
| `Quality / engine-test` | `quality.yml` |
| `Quality / engine-lint` | `quality.yml` |
| `Quality / engine-vuln` | `quality.yml` |
| `Quality / relay-test` | `quality.yml` |
| `Quality / desktop-test` | `quality.yml` |
| `Quality / desktop-audit` | `quality.yml` |
| `Quality / file-size` | `quality.yml` |
| `Quality / ios-build` | `quality.yml` |
| `Quality / actionlint` | `quality.yml` |
| `Quality / docker-build` | `quality.yml` |

### Path-scoped pull-request checks

Quality keeps its existing job names so required-check rules remain stable. On a pull request, `changes` classifies the PR diff and product jobs outside that scope are marked **skipped** rather than omitted. GitHub treats those skipped contexts as successful, while avoiding unrelated runners and package scans.

Examples: a docs-only PR runs the universal file-size gate, not engine/desktop/relay tests, package vulnerability scans, Docker, or iOS compilation; a `desktop/package-lock.json` update additionally runs the desktop audit; an iOS change runs SwiftLint and the device build. Workflow YAML changes run actionlint. The classifier mapping is pinned by `scripts/test-quality-path-scopes.sh`.

Pushes to `main`, scheduled runs, and manual dispatches intentionally run every product scope. This preserves full post-merge and scheduled coverage even though pull requests get change-scoped feedback.

### Require branches to be up to date

Enabled. A PR's branch must be up to date with `main` before merging. This prevents cross-PR regressions where two independently-clean PRs produce lint or build failures when combined.

### Linear history

**Not enabled.** Merge commits are required — release-damnit parses conventional commit messages from merge nodes to generate changelogs and determine version bumps.

## Release pipeline bypass

The release workflow (`release.yml`) pushes version-bump commits (VERSION, CHANGELOG, manifest files) directly to `main` using a GitHub App token. The GitHub App must be added to the ruleset's **bypass list** so these automated commits are not blocked by the status check requirement.

If the App is not in the bypass list, release-damnit's `git push` to `main` will be rejected by branch protection.

## Lint strategy

On pull requests, the `engine-lint` context runs only when engine, relay, or Go SDK paths changed, and lints only changed package scopes. Pushes to `main`, scheduled runs, and manual dispatches run every package lint. This keeps PR feedback scoped without letting lint debt accumulate after merge.
