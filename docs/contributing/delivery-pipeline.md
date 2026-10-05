---
title: Delivery Pipeline
description: How a push to main becomes versioned, built releases, how tests decide when each one goes public, and why neither tests nor scans ever block a push.
sidebar_position: 7
---

# Delivery Pipeline

Code lands on `main` by direct push. Every push is versioned and built without waiting on a review, a test run, or a scan. A built release goes public only once its tests pass for that commit. Test failures and scan findings arrive as issues; neither ever blocks a push.

The rule in one line: **if it is on `main`, every service that changed gets a version and a binary; users get the binary once its tests pass.**

## What happens on a push

Three lanes start at once. None waits for another.

| Lane | Workflow | Starts | Finishes | Holds a release? |
|------|----------|--------|----------|-------------------|
| Version | `release.yml` (job `release`) | On push | Under a minute | It *is* the release |
| Build | `build.yml` (called by `release.yml`) | After the version lane | Engine ~5 min, desktop ~10 min | Only its own service |
| Test | `quality.yml` | On push | Depends on scope | Each service whose gating jobs failed or are still running |
| Publish | `build.yml` job `publish`, and `publish.yml` after every Quality run | When a build or a test run finishes | Seconds | It *is* the publish |

### The version lane

`release-damnit` reads the conventional commits since each service's last release. The commit scope (`engine`, `desktop`, `server`, ...) picks the service; the type (`feat`, `fix`, `feat!`) picks the bump. It writes `VERSION`, `CHANGELOG.md`, and `release-please-manifest.json`, pushes them as `chore: release versions [skip ci]`, and creates one GitHub release per service that changed. The scope map is `.commit.json`; the per-service release config is `release-please-config.json`.

Nothing is manual. A commit with a `docs` scope, or under a path `release.yml` does not list, releases nothing.

When the push releases the desktop, `release.yml` also writes its "What's new" notes before the version commit. Every person who runs Ion Studio reads them, so `.github/scripts/write-whats-new.mjs` passes them through three gates:

1. The Ion engine image drafts plain-language bullets from the commits that ship in the app (desktop, server, engine), following `.github/ion/whats-new-prompt.md`.
2. `lintHighlight` drops any bullet that carries engineering text: technical words, code, file names, links, commit ids, issue numbers.
3. A second, separate run follows `.github/ion/whats-new-review-prompt.md` and keeps or drops each remaining bullet: accurate, plain, appropriate for everyone, and clear on its own. An answer that is not one verdict per bullet keeps none.

Only kept bullets are written into `desktop/whats-new.json` under the new version. The version commit carries that file, so the desktop build of that version bakes the entry in and the Build Notice shows it. A release with nothing a person would notice gets no entry. The notes never hold a release: an engine failure or an unclear answer is a warning, and the version ships without notes. Edit the file by hand to correct an entry; a build already shipped keeps the text it was built with.

Every CI job that asks Ion to write something runs it through `.github/scripts/run-ion-prompt.sh`, which points the engine image at the `ION_ENGINE_CONFIG_B64` config and fails on an engine error or an empty answer.

Two pushes close together do not race: `release.yml` runs under a concurrency group that queues the second run until the first has pushed its version commit.

### The build lane

A release is created **as a draft**. `.github/scripts/hold-built-releases.sh` runs right after `release-damnit` and holds every release that has a build job (`engine`, `server`, `desktop`, `relay`) as a draft. A draft is invisible to the desktop auto-updater, to `/releases/latest`, and to `ion studio update`. Releases with nothing to build (`ios`, `sdk/go`) are published on the spot.

`build.yml` then builds only the services in the release report, from the pushed commit plus its version bump (never whatever `main` has moved to since). Each service has a `ready-<service>` job that runs once every job that attaches one of its assets has succeeded. It sets the commit status `release/<service>` on the pushed commit, naming the tag (and, for the server, the engine release its bundle carries). Images push only their version tags; `:latest` moves at publish.

So a failure in one service's build leaves that service's draft in place. The draft has all the assets that did upload; rerun the failed jobs from the run page and the ready job runs again. A release is never public with files missing.

### The publish step

`.github/scripts/publish-tested-releases.mjs` makes a draft public when both halves are done for the commit it was cut from: its `release/<service>` status says the build is ready, and every Quality job that gates the service passed. Builds and tests finish in either order, so it runs at both ends: `build.yml`'s `publish` job and the `publish.yml` workflow on every Quality completion on `main`, including a rerun. One concurrency group keeps the two from interleaving, and each run sweeps every draft, so whichever finishes second publishes.

Which Quality jobs gate which service is the `GATES` table in that script. A service that carries another's code waits for its jobs too: the desktop builds the engine and the server from the same commit, and the server bundle waits for the engine release it carries to be public. A gating job that a push skipped (its paths were untouched) takes the verdict of the nearest earlier run of it, since its inputs have not changed since then. A job that was cancelled holds until it is rerun.

Publishing a service's newest version moves its `ghcr.io` `:latest` tag and, for the engine, marks the release `latest`, because the README install command resolves through `/releases/latest`. An older version whose tests pass after a newer one goes public without taking `latest` back.

When every release a push cut is public, the publish step dispatches the release summary (`release-summary.yml`) with the Release run that saved the push's report.

A failed build is filed, the same way a failed test is. `build.yml` ends in a `report` job that files an issue per failed job, labelled `ci-failure`, titled `Release build failed on main: <job>`. `release.yml` has its own for the jobs outside the build, titled `Release failed on main: <job>`. A dry run files nothing.

The Windows install smoke test (`scripts/ci/windows-smoke.ps1`) is the one runtime check inside the build lane. Its failure is a product bug found after the installer was built: the installer still uploads, the desktop still publishes, and an issue is filed. A `dry_run` of `build.yml` is the exception: there, a smoke failure fails the job, because surfacing it is what a dry run is for.

### The test lane

`quality.yml` runs every test, lint, and drift check, scoped to the paths the push touched. An iOS-only push runs no Windows job; an engine push runs the engine matrix on all three operating systems and nothing for the desktop. The scope map is `.github/quality-paths.yml`, pinned by `scripts/test-quality-path-scopes.sh`. Scheduled and manual runs validate every scope. A push to `main` never cancels an earlier push's run: each run is the verdict its commit's releases wait for.

The lane ends in a `report` job that reads every job's result and files an issue per failure, labelled `ci-failure`, titled `Tests failed on main: <job>`. A failure in a gating job keeps that service's release a draft: fix forward (the next push cuts a new release), or rerun the job if it was flaky. A repeat of the same failure comments on the open issue instead of opening another. Pull requests, when you open one, get their checks inline and file nothing.

**Flaky tests are filed, not tolerated.** When a run is rerun and a job that failed on the earlier attempt passes on this one, the commit did not change, so the test is flaky. The `report` job files it under the `flaky` label. That issue is fixed the day it appears.

The engine tests reuse Go's test cache between runs (`actions/cache` keyed on the run id, restored by prefix), so a package the push did not touch is reported from cache in milliseconds.

### The security lane

Dependency advisories and vulnerability scans read a feed that changes every day, so their result is not a property of the commit. `security.yml` runs `govulncheck` and `npm audit` nightly and on demand, never on a push, and files each finding under the `security` label. A new advisory never turns a push red and never holds a release.

## `main` is made of merge nodes

Every push to `main` moves it to a merge commit: one node per piece of work, carrying the branch it came from. `release-damnit` reads the commit graph through those nodes.

**Land with `make land <branch>`.** It fetches `main`, sets local `main` to it, merges the branch with `--no-ff`, and pushes. The pipeline pushes a version-bump commit to `main` after every landing, so a second landing within a minute or two can find `main` moved mid-push; the remote refuses that push, and `make land` merges again on top of the new commit and pushes again, on its own. It refuses rather than resets when local `main` holds a commit that is neither on the remote nor a copy of one on the branch, stops on a merge conflict (rebase the branch onto `main`, resolve there, land again), and always returns to the branch it started on. Script: `scripts/land.sh`.

By hand it is `git merge <branch>` then `git push`, standing on `main`. `make bootstrap` sets two things so that stays safe: `branch.main.mergeoptions --no-ff`, so the merge always makes a node, and `branch.main.rebase merges`, so a `git pull` after a lost race replays the merge instead of flattening it.

The hook enforces the shape before any gate runs. `scripts/check-main-merge-node.sh` refuses a push that would move `main` to a non-merge tip: a fast-forward of a branch and a commit made straight on `main` are both refused. `scripts/check-main-current.sh` asks the remote where `main` is and refuses, in a second, a push built on an older `main`, instead of letting it run the gates and then be rejected. The pipeline's own version-bump commit is not affected; it is pushed from CI, where no local hook runs.

## The gate in front of `main`

There is one: the local `pre-push` hook (`scripts/pre-push.sh`). It runs only what is static or a compile, scoped to the components the branch touched, so a push waits about a minute: file-size caps, tracked-binary check, toolchain alignment, vocabulary drift, engine lint and build plus the Windows cross-build, relay lint, desktop typecheck, server typecheck and lint, the renderer bundle, and SwiftLint. No test suite runs in the hook.

`git push --no-verify` bypasses it. Use that when you mean it.

## Pull requests are optional

The `main` ruleset (Settings → Rules → Rulesets → `default`) keeps two rules: no deletion, no force-push. It requires no pull request and no status check. The GitHub App that pushes version commits stays in the bypass list.

Open a pull request when you want a review or a preview. Its checks run inline and are advisory. `/create-pr` still works for that.

## Rerunning and rebuilding

| Need | Do |
|------|----|
| A build job failed and the draft is waiting | Re-run failed jobs on the run page. Passed jobs are kept; the ready and publish jobs run when the failed ones pass. |
| A test failed and the draft is waiting | Fix forward, or re-run the failed Quality jobs if they were flaky. `publish.yml` sweeps when the rerun finishes. |
| See why a release is still a draft | Open the latest **Publish** run, or the `publish` job of the build: each held release has one line saying what it waits for. Run **Publish** by hand to sweep again. |
| Rebuild the Windows installer for the current desktop version, no new release | Run the **Rebuild Windows Desktop** workflow (`rebuild-windows.yml`). |
| Reproduce a release-only failure from a branch | Run **Build** by hand with `dry_run: true`, the branch as `ref`, and a release report naming versions that already exist. |
| Re-send the release summary | Run **Release Summary** by hand with the Release run id, or paste the release report. |

## What this trades

`main` can carry a broken build or a failing test for the minutes it takes to fix forward. That is the chosen trade: integration is never blocked, a version exists for every change, and a bug is a bug with a link, not a stalled branch. What users install is held to a stricter rule: a service's release reaches them only after its tests pass.
