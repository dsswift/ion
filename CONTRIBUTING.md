# Contributing to Ion

Thanks for the interest. This repository is a monorepo that releases each
component independently from a single `main` branch. The release pipeline is
automated, but it depends on a specific git workflow. Please read this whole
document before opening your first PR.

## Repository Layout

`main` is the only long-lived branch. Components live in their own directories
and are versioned independently:

| Directory  | Component | Released as                      |
|------------|-----------|----------------------------------|
| `engine/`  | engine    | binary archives + checksums      |
| `desktop/` | desktop   | (artifacts via release pipeline) |
| `relay/`   | relay     | container image (GHCR)           |
| `ios/`     | ios       | (artifacts via release pipeline) |

Each component has its own `VERSION` file and `CHANGELOG.md`. Both are
maintained automatically by the release workflow. Do not edit them by hand.

## Branching Model

Every change reaches `main` through a pull request. Direct pushes to `main`
are blocked by branch protection.

1. Create a branch off the latest `main`:
   ```bash
   git checkout main
   git pull --ff-only
   git checkout -b feat/engine-add-thing
   ```
2. Make your changes.
3. Commit using [Conventional Commits](#conventional-commits).
4. Push the branch and open a PR against `main`.
5. Wait for CI build to succeed.
6. Merge the PR using **"Create a merge commit"**. Do not squash. Do not rebase. (See [Why merge commits matter](#why-merge-commits-matter).)

Suggested branch name patterns (not enforced):

- `feat/<scope>-<short-desc>`
- `fix/<scope>-<short-desc>`
- `chore/<scope>-<short-desc>`
- `docs/<scope>-<short-desc>`

## Conventional Commits

Every commit message must follow Conventional Commits. The release pipeline
parses these and uses them to decide whether and how to bump component
versions.

Format:

```
<type>(<scope>): <description>
```

Rules:

- **type**: one of the allowed types listed below.
- **scope**: the component name. Required when the change targets a
  releasable component.
- **description**: lowercase, imperative mood, no trailing period, 50
  characters or fewer.

### Allowed types and bump behavior

| Type      | Version bump | Notes                                       |
|-----------|--------------|---------------------------------------------|
| `feat`    | minor        | New user-visible capability                 |
| `fix`     | patch        | Bug fix                                     |
| `perf`    | patch        | Performance improvement                     |
| `chore`   | none         | Internal work, build, tooling               |
| `docs`    | none         | Documentation only                          |
| `style`   | none         | Formatting, whitespace, no code change      |
| `refactor`| none         | Code change that neither fixes nor adds     |
| `test`    | none         | Test-only changes                           |
| `feat!`   | major        | Breaking change. Also: `BREAKING CHANGE:` footer |

Allowed types are limited to: `feat`, `feat!`, `fix`, `chore`, `docs`. Other
types (`style`, `refactor`, `test`, `perf`) are recognized by the release
tool but are not part of our commit policy.

### Scope is the component name

Use the component directory name as the scope:

- `engine`, `desktop`, `relay`, `ios` for component changes.
- `repo` for repository-wide changes (root `Makefile`, `.gitignore`,
  workflow YAML, etc.).
- `docs` for repository-wide documentation that doesn't belong to one
  component.

Only commits scoped to a releasable component (`engine`, `desktop`,
`relay`, `ios`) can trigger a release for that component. A `chore(repo)`
commit produces no release no matter what type is attached.

### Examples

Good:

```
feat(engine): add JSON-RPC retry policy
fix(desktop): prevent crash on empty session list
chore(repo): bump go version in CI
docs(engine): document the new retry policy
feat(ios)!: replace credential keychain layout
```

Bad:

```
feat: add retry policy                # missing scope
Feat(engine): Add retry policy.       # capitalization, trailing period
fixed engine crash                    # missing type
chore(misc): cleanup                  # invented scope
```

## Pull Request Workflow

1. **Open the PR** with a clear title and a short body explaining the
   intent. The first commit's subject often makes a fine PR title.
2. **CI build** runs on every push to the branch. It must be green before
   merging.
3. **Review**: in a solo configuration, self-review the diff. With
   collaborators, request review from a maintainer.
4. **Merge** with **"Create a merge commit"**. The button is the green
   "Merge pull request" dropdown on the PR page; pick "Create a merge
   commit". GitHub may default to squash if both options are enabled in
   repo settings; verify the dropdown reads "Create a merge commit"
   before clicking.

After merge:

- The release workflow runs automatically against the merge commit.
- For each component that received a `feat` / `fix` / `perf` / breaking
  change in the merged branch, the workflow:
  - Bumps the `VERSION` file.
  - Appends an entry to `CHANGELOG.md`.
  - Updates `release-please-manifest.json`.
  - Pushes a `chore: release versions [skip ci]` commit back to `main`.
  - Creates a GitHub release with tag `<component>-v<version>`.
- The build workflow runs against the new tags and uploads artifacts
  (binaries, container images) to each release.

## Why Merge Commits Matter

The release tool walks the merge range
`merge-base(main, branch)..branch-tip` to discover all commits that landed
in the merge. It can only do this when the merge produced an actual merge
commit (one with two parents). Squash and rebase merges look like single
commits on `main`, so the tool falls back to inspecting only the tip
commit. Any `feat`/`fix` commits hidden in the branch's history get
silently dropped.

Concretely:

- **"Create a merge commit"**: every branch commit is seen. Each component
  bumps based on the highest-priority commit type that touched it.
- **"Squash and merge"**: the squash commit's message is the only signal.
  If you scope it to one component, only that component bumps. Multiple
  components in one squash will not all bump.
- **"Rebase and merge"**: the branch commits land on `main` linearly with
  no merge commit, same fallback as direct pushes.

We disable squash and rebase merging at the repo level to keep this from
being a foot-gun. If you see those options enabled in the UI, treat it as
a config drift bug and report it.

## Releases Are Automatic

Do not edit any of the following by hand:

- `engine/VERSION`, `desktop/VERSION`, `relay/VERSION`, `ios/VERSION`
- `engine/CHANGELOG.md`, `desktop/CHANGELOG.md`, `relay/CHANGELOG.md`,
  `ios/CHANGELOG.md`
- `release-please-manifest.json`
- `desktop/package.json` `version` field

These are owned by the release pipeline. Hand edits will get clobbered by
the next auto-commit at best, and produce inconsistent state at worst.

If you believe a release came out wrong, open an issue. Maintainers will
correct via revert PR or follow-up release rather than direct hand edit.

## Local Testing

Before opening a PR, run the relevant target from the root `Makefile`:

| Component | Quick check                       |
|-----------|-----------------------------------|
| engine    | `make engine` (builds and installs) |
| desktop   | `make desktop`                     |
| relay     | `make relay` (builds container)    |
| ios       | `make ios-check` (build only, no install) |
| All Go tests | `make test`                     |

To validate the release pipeline locally before pushing, install
release-damnit and run a dry analysis:

```bash
go install github.com/dsswift/release-damnit/cmd/release-damnit@latest
release-damnit --dry-run
```

This prints the version bumps the release workflow would emit, computed
from your local git history, without modifying anything.

## Reporting Issues

Open issues at https://github.com/dsswift/ion/issues. Include:

- Component (`engine`, `desktop`, `relay`, `ios`).
- Version (`<component>/VERSION` content or release tag).
- Steps to reproduce.
- Expected vs actual behavior.
- Logs or stack traces when relevant.

## Reference

- `.github/workflows/release.yml` — release detection and tagging.
- `.github/workflows/build.yml` — artifact build and upload.
- `release-please-config.json` — component definitions.
- `release-please-manifest.json` — current version of each component (read-only for contributors).
- https://github.com/dsswift/release-damnit — the release-detection tool used by `release.yml`.
