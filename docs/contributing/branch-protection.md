---
title: Branch Protection
description: GitHub branch protection settings for the Ion repository.
sidebar_position: 4
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

### Require branches to be up to date

Enabled. A PR's branch must be up to date with `main` before merging. This prevents cross-PR regressions where two independently-clean PRs produce lint or build failures when combined.

### Linear history

**Not enabled.** Merge commits are required — release-damnit parses conventional commit messages from merge nodes to generate changelogs and determine version bumps.

## Release pipeline bypass

The release workflow (`release.yml`) pushes version-bump commits (VERSION, CHANGELOG, manifest files) directly to `main` using a GitHub App token. The GitHub App must be added to the ruleset's **bypass list** so these automated commits are not blocked by the status check requirement.

If the App is not in the bypass list, release-damnit's `git push` to `main` will be rejected by branch protection.

## Lint strategy

The `engine-lint` job runs differently depending on the trigger:

- **On `pull_request`:** Differential lint via `--new-from-merge-base=origin/main`. Only reports issues on lines changed since the branch diverged from main. Fast feedback for contributors.
- **On `push` to `main`:** Full lint with no filter. Catches cross-PR regressions that slip through differential checks (e.g., one PR adds a function, another removes its only caller → `unused` error only visible after both merge).

This two-tier approach balances PR developer experience (no noise from pre-existing issues) with main branch integrity (no accumulated lint debt).
