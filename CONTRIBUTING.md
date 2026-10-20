# Contributing to Ion

Thanks for the interest. This repository is a monorepo that releases each
package independently from a single `main` branch. The release pipeline is
automated, and it reads your commit messages to decide what to release.
Please read this whole document before your first change.

## Repository Layout

`main` is the only long-lived branch. The packages are listed in
`release-please-config.json`, and each one is versioned on its own:

| Directory  | Commit scope | Released as                      |
|------------|--------------|----------------------------------|
| `engine/`  | `engine`     | binary archives + checksums      |
| `desktop/` | `desktop`    | installers                       |
| `server/`  | `server`     | Studio Server archives + checksums |
| `relay/`   | `relay`      | container image (GHCR)           |
| `ios/`     | `ios`        | (artifacts via release pipeline) |
| `sdk/go/`  | `sdk`        | Go module tag `sdk/go/v<version>` |

Each package has its own `VERSION` file and `CHANGELOG.md`. Both are
maintained automatically by the release workflow. Do not edit them by hand.

## How Work Lands

Maintainers work on `main` and land with `make land`, which runs
`release-damnit land`. It rebases the local commits onto the remote `main`,
checks every commit message, and pushes. When the pipeline's version commit
moved `main` in the meantime, it fetches and tries again. A branch or
worktree lands with `make land <branch>`, as one merge commit.

Outside contributors open a pull request against `main`. Keep its commits
in the shape below; they land as they are, never squashed.

`make bootstrap` once per clone installs the git hooks. The `commit-msg`
hook runs `release-damnit check-commit`, so it needs `release-damnit` on
your `PATH`:

```bash
go install github.com/dsswift/release-damnit/cmd/release-damnit@latest
```

## Commit Messages

Format:

```
<type>(<scope>): <description>
```

- **type**: `feat`, `feat!`, `fix`, `chore`, or `docs`.
- **scope**: the package the commit touches (see the table above). A
  commit that touches no package uses a repo-level scope: `repo` (root
  files, `packages/`, `scripts/`), `docs`, `ci` (`.github/`), or `deps`.
- **description**: lowercase, imperative mood, no trailing period, 65
  characters or fewer.

One commit touches one package. Files outside every package may ride
along. The hook rejects a commit that spans packages and lists which files
belong to which one; unstage with `git restore --staged <files>` and commit
each package on its own.

### Types and bump behavior

| Type    | Version bump              |
|---------|---------------------------|
| `feat`  | minor (patch before 1.0)  |
| `fix`   | patch                     |
| `feat!` | major                     |
| `chore` | none                      |
| `docs`  | none                      |

### Examples

Good:

```
feat(engine): add JSON-RPC retry policy
fix(desktop): prevent crash on empty session list
chore(repo): bump go version in the makefile
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

## Releases Are Automatic

Every push to `main` runs the release workflow over every commit in the
push. For each package a `feat`, `fix`, or `feat!` commit touched, it:

- Bumps the `VERSION` file and appends to `CHANGELOG.md`.
- Updates `release-please-manifest.json`.
- Pushes a `chore: release versions [skip ci]` commit back to `main`.
- Creates a GitHub release tagged `<component>-v<version>`.

Each release that has artifacts is held as a draft while the build
workflow uploads them. It goes public once its artifacts are attached and
its tests in the Quality workflow pass. A release whose tests fail stays a
draft and never reaches users.

Do not edit any `VERSION`, `CHANGELOG.md`, or `release-please-manifest.json`
by hand. They are owned by the release pipeline. If a release came out
wrong, open an issue; it is corrected with the next release, never with a
hand edit.

## Local Testing

Before landing, run the relevant target from the root `Makefile`:

| Component | Quick check                       |
|-----------|-----------------------------------|
| engine    | `make engine` (builds and installs) |
| desktop   | `make desktop`                     |
| relay     | `make relay` (builds container)    |
| ios       | `make ios-pr-check` (device build plus targeted contract/parity tests) |
| All Go tests | `make test`                     |

To see what the release workflow would version, run a dry analysis:

```bash
release-damnit --dry-run
```

This prints the version bumps the release workflow would emit, computed
from your local git history, without modifying anything.

## Reporting Issues

Open issues at https://github.com/dsswift/ion/issues. Include:

- Package (`engine`, `desktop`, `server`, `relay`, `ios`, `sdk`).
- Version (`<component>/VERSION` content or release tag).
- Steps to reproduce.
- Expected vs actual behavior.
- Logs or stack traces when relevant.

## Reference

- `.github/workflows/release.yml` — release detection and tagging.
- `.github/workflows/build.yml` — artifact build and upload. Dispatch it with `dry_run` and a `ref` to build and verify a branch (signing, the Windows smoke test) without publishing anything.
- `.github/workflows/publish.yml` and `.github/scripts/publish-tested-releases.mjs` — publish each held release once it is built and its tests pass. See `docs/contributing/delivery-pipeline.md`.
- `release-please-config.json` — component definitions.
- `release-please-manifest.json` — current version of each component (read-only for contributors).
- https://github.com/dsswift/release-damnit — the release-detection tool used by `release.yml`.
