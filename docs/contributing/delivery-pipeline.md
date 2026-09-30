---
title: Delivery Pipeline
description: How a push to main becomes versioned, built, published releases, and where tests and scans fit so they never hold a release.
sidebar_position: 7
---

# Delivery Pipeline

Code lands on `main` by direct push. Every push is versioned, built, and published without waiting on a review, a test run, or a scan. Tests and scans still run; their findings arrive as issues, not as blocked releases.

The rule in one line: **if it is on `main`, every service that changed gets a version and a binary.**

## What happens on a push

Three lanes start at once. None waits for another.

| Lane | Workflow | Starts | Finishes | Blocks a release? |
|------|----------|--------|----------|-------------------|
| Version | `release.yml` (job `release`) | On push | Under a minute | It *is* the release |
| Build and publish | `build.yml` (called by `release.yml`) | After the version lane | Engine ~5 min, desktop ~10 min | Only its own service |
| Test | `quality.yml` | On push | Depends on scope | Never |

### The version lane

`release-damnit` reads the conventional commits since each service's last release. The commit scope (`engine`, `desktop`, `server`, ...) picks the service; the type (`feat`, `fix`, `feat!`) picks the bump. It writes `VERSION`, `CHANGELOG.md`, and `release-please-manifest.json`, pushes them as `chore: release versions [skip ci]`, and creates one GitHub release per service that changed. The scope map is `.commit.json`; the per-service release config is `release-please-config.json`.

Nothing is manual. A commit with a `docs` scope, or under a path `release.yml` does not list, releases nothing.

Two pushes close together do not race: `release.yml` runs under a concurrency group that queues the second run until the first has pushed its version commit.

### The build lane

A release is created **as a draft**. `.github/scripts/hold-built-releases.sh` runs right after `release-damnit` and holds every release that has a build job (`engine`, `server`, `desktop`, `relay`) as a draft. A draft is invisible to the desktop auto-updater, to `/releases/latest`, and to `ion studio update`. Releases with nothing to build (`ios`, `sdk/go`) are published on the spot.

`build.yml` then builds only the services in the release report. Each service has a `publish-<service>` job that flips its draft public once every job that attaches one of its assets has succeeded. The engine's publish job also marks it `latest`, because the README install command resolves through `/releases/latest`.

So a failure in one service's build leaves that service's draft in place and publishes every other service. The draft has all the assets that did upload; rerun the failed jobs from the run page and the publish job runs again. A release is never public with files missing.

The Windows install smoke test (`scripts/ci/windows-smoke.ps1`) is the one runtime check inside the build lane. Its failure is a product bug found after the installer was built: the installer still uploads, the desktop still publishes, and an issue is filed. A `dry_run` of `build.yml` is the exception: there, a smoke failure fails the job, because surfacing it is what a dry run is for.

### The test lane

`quality.yml` runs every test, lint, and drift check, scoped to the paths the push touched. An iOS-only push runs no Windows job; an engine push runs the engine matrix on all three operating systems and nothing for the desktop. The scope map is `.github/quality-paths.yml`, pinned by `scripts/test-quality-path-scopes.sh`. Scheduled and manual runs validate every scope.

The lane ends in a `report` job that reads every job's result and files an issue per failure, labelled `ci-failure`, titled `Tests failed on main: <job>`. A repeat of the same failure comments on the open issue instead of opening another. Pull requests, when you open one, get their checks inline and file nothing.

**Flaky tests are filed, not tolerated.** When a run is rerun and a job that failed on the earlier attempt passes on this one, the commit did not change, so the test is flaky. The `report` job files it under the `flaky` label. That issue is fixed the day it appears.

The engine tests reuse Go's test cache between runs (`actions/cache` keyed on the run id, restored by prefix), so a package the push did not touch is reported from cache in milliseconds.

### The security lane

Dependency advisories and vulnerability scans read a feed that changes every day, so their result is not a property of the commit. `security.yml` runs `govulncheck` and `npm audit` nightly and on demand, never on a push, and files each finding under the `security` label. A new advisory never turns a push red and never holds a release.

## `main` is made of merge nodes

Every push to `main` moves it to a merge commit: one node per piece of work, carrying the branch it came from. `release-damnit` reads the commit graph through those nodes. The flow is, on `main`, `git merge <branch>` then `git push`. `make bootstrap` sets `branch.main.mergeoptions --no-ff`, so that merge always produces a node even when a fast-forward was possible.

The hook enforces it: `scripts/check-main-merge-node.sh` reads the refs being pushed and refuses any that would move `main` to a non-merge tip. A fast-forward of a branch and a commit made straight on `main` are both refused. The pipeline's own version-bump commit is not affected; it is pushed from CI, where no local hook runs.

## The gate in front of `main`

There is one: the local `pre-push` hook (`scripts/pre-push.sh`). It runs only what is static or a compile, scoped to the components the branch touched, so a push waits about a minute: file-size caps, tracked-binary check, toolchain alignment, vocabulary drift, engine lint and build plus the Windows cross-build, relay lint, desktop typecheck, server typecheck and lint, the renderer bundle, and SwiftLint. No test suite runs in the hook.

`git push --no-verify` bypasses it. Use that when you mean it.

## Pull requests are optional

The `main` ruleset (Settings → Rules → Rulesets → `default`) keeps two rules: no deletion, no force-push. It requires no pull request and no status check. The GitHub App that pushes version commits stays in the bypass list.

Open a pull request when you want a review or a preview. Its checks run inline and are advisory. `/create-pr` still works for that.

## Rerunning and rebuilding

| Need | Do |
|------|----|
| A build job failed and the draft is waiting | Re-run failed jobs on the run page. Passed jobs are kept; the publish job runs when the failed ones pass. |
| Rebuild the Windows installer for the current desktop version, no new release | Run the **Rebuild Windows Desktop** workflow (`rebuild-windows.yml`). |
| Reproduce a release-only failure from a branch | Run **Build** by hand with `dry_run: true`, the branch as `ref`, and a release report naming versions that already exist. |
| Re-send the release summary | Run **Release Summary** by hand with the release report from the run. |

## What this trades

`main` can carry a broken build for the minutes it takes to fix forward, and a test failure ships with an issue attached. That is the chosen trade: integration is never blocked, a version exists for every change, and a bug is a bug with a link, not a stalled branch.
