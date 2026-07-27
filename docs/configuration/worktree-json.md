---
title: worktree.json Reference
description: Declare the gitignored dependency state a worktree needs so Ion can provision it.
sidebar_position: 6
---

# worktree.json Reference

`.ion/worktree.json` is a **committed, project-level** file that tells Ion what a
working copy of your project needs beyond what git tracks. When Ion creates a
worktree it reads this manifest and materialises those directories, so a new
worktree can build immediately instead of arriving as a bare checkout.

**The file is optional.** With no manifest, worktree creation behaves exactly as
it did before this feature existed.

## Why it is needed

A git worktree contains only tracked files. Everything gitignored but required
for local development is absent:

- `node_modules/` (npm, pnpm, yarn)
- `vendor/` (Go, PHP)
- `.venv/` (Python)
- `target/` (Rust, Maven)
- `Pods/` (CocoaPods)
- Git hooks, generated config, build caches

Git will never carry these — that is the point of ignoring them — so something
has to put them there.

## Shape

```json
{
  "version": 1,
  "worktree": {
    "seed": [
      {
        "path": "node_modules",
        "build": "npm ci",
        "staleWhen": ["package-lock.json"]
      }
    ],
    "setup": "make bootstrap"
  }
}
```

### Top-level

| Field | Type | Description |
|---|---|---|
| `version` | int | Manifest format version. Must be `1`. An unrecognised version disables provisioning rather than risking a misread. |
| `worktree.seed` | array | Directories to materialise. See below. |
| `worktree.setup` | string | Your project's own idempotent setup command, run once after all seeding. |

### Seed entries

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Repo-relative directory to materialise. **Must be gitignored** (see Rules). |
| `build` | string | no | Command that rebuilds this directory from scratch. Used when no copy-on-write clone is available, and to reconcile staleness. |
| `cwd` | string | no | Repo-relative directory to run `build` in. Defaults to the repo root. |
| `staleWhen` | string[] | no | Files whose content decides whether the seeded directory is still valid — normally lockfiles. |

## How Ion materialises a seed entry

| Rung | When | Cost |
|---|---|---|
| **clone** | Copy-on-write reflink is available between the repo and the worktree root | near-zero time and disk |
| **build** | No reflink — runs your `build` command | a normal install |
| **copy** | Only when no `build` is declared | full disk, slow |

Capability is **probed**, not assumed from the platform. Reflink is a property of
the volume pair, so the answer differs between APFS and an external HFS+ disk,
between Btrfs and ext4, and between a Windows Dev Drive and NTFS. Ion writes a
temporary file and attempts a forced reflink to find out.

Reflink also requires source and destination on the **same volume**. If your repo
and the worktree root are on different disks, every entry falls to `build`.

### Why build beats copy

Both produce an independent tree, so copy's only advantage is working offline —
while its cost is unbounded. `build` is also more correct: it reconciles against
*that worktree's* lockfile rather than snapshotting whatever state the source
happened to be in. Copy exists only for directories with no way to rebuild them.

### Clones are safe to write to

A reflink shares physical blocks but is a separate file. The first write to
either side duplicates the affected blocks, so `npm install` inside a cloned
worktree affects nothing else and costs only its real delta.

Ion never symlinks a shared dependency directory. A symlink is one directory with
two names, so an install in any worktree would mutate the main clone and every
sibling.

## Rules

**Seeded paths must be gitignored.** Ion runs `git check-ignore` on every
declared `path` and refuses any that git tracks or would report as untracked.
Seeding a non-ignored path would leave it in `git status`, which is the exact
problem this feature exists to avoid.

**Paths must stay inside the repo.** Absolute paths, drive-qualified paths, and
any `..` segment are rejected when the manifest is read.

**Malformed manifests fail open.** A syntax error, an unknown version, or a bad
entry disables provisioning (with a warning in `~/.ion/desktop.jsonl`) rather
than blocking worktree creation.

**Commands are project-authored and run as-is.** Ion executes what the manifest
declares, in the worktree, with output captured. This is the same trust posture
as your git hooks or an `npm install` postinstall script — and a manifest is only
read from a repo you already opened.

## Keeping a worktree current

Three mechanisms, in the order they usually apply:

1. **Just install.** Every rung produces an independent tree, so running your
   package manager in the worktree is correct with no involvement from Ion.
2. **Automatic staleness.** After seeding, Ion compares each `staleWhen` file
   against the source. On divergence it runs `build` — this is what catches a
   sibling's dependency bump after a sync.
3. **Re-provision.** A worktree row-menu verb that re-runs the whole ladder.

## Examples

### Node monorepo

```json
{
  "version": 1,
  "worktree": {
    "seed": [
      { "path": "node_modules", "build": "npm ci", "staleWhen": ["package-lock.json"] },
      { "path": "web/node_modules", "build": "npm ci", "cwd": "web",
        "staleWhen": ["web/package-lock.json"] }
    ],
    "setup": "npm run prepare"
  }
}
```

### Go

```json
{
  "version": 1,
  "worktree": {
    "seed": [
      { "path": "vendor", "build": "go mod vendor", "staleWhen": ["go.mod", "go.sum"] }
    ]
  }
}
```

### Python (uv)

```json
{
  "version": 1,
  "worktree": {
    "seed": [
      { "path": ".venv", "build": "uv sync", "staleWhen": ["uv.lock"] }
    ]
  }
}
```

### Rust

```json
{
  "version": 1,
  "worktree": {
    "seed": [
      { "path": "target", "build": "cargo fetch", "staleWhen": ["Cargo.lock"] }
    ]
  }
}
```

### A cache with no rebuild command

A derived artifact that is expensive to regenerate and cheap to clone can declare
no `build` at all; Ion clones it, or copies it when reflink is unavailable.

```json
{
  "version": 1,
  "worktree": {
    "seed": [{ "path": ".build-cache" }]
  }
}
```

## Observability

Every decision lands in `~/.ion/desktop.jsonl` under `tag=worktree.provision`:
the manifest that was loaded, the probed reflink capability per volume pair, the
rung chosen for each entry with elapsed time, and the full reason for any
refusal or failure.

```bash
jq -c 'select(.tag=="worktree.provision")' ~/.ion/desktop.jsonl
```
