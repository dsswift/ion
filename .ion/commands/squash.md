---
description: Rebuild a feature branch into clean conventional commits while preserving its exact final tracked tree.
model: standard
---

# /squash

Rebuild current feature branch into clean conventional commits without changing
tracked content. This command is **history-only**.

## Absolute invariant

> Final `HEAD^{tree}` must equal starting `HEAD^{tree}` byte-for-byte.

Never edit source. Never fix defects. Never resume prior implementation.
Never run builds, tests, formatters, generators, package managers, background
agents, or dependency commands. Never push.

Allowed operations:

- Read-only inspection: `git status`, `git log`, `git show`, `git diff`,
  `git diff-tree`, `git rev-parse`, `git rev-list`, `git branch`.
- History/staging: `git branch`, `git reset --soft`, `git reset`,
  `git restore --staged`, `git add`, `git add -p`, `git commit`.
- `AskUserQuestion` at decision gates.

Forbidden operations:

- `Edit`, `Write`, `Agent`, or any source-changing command after invocation.
- Patch-edit mode (`e`) inside `git add -p`.
- `git checkout -- <path>`, `git restore <path>`, cherry-pick, rebase, merge,
  push, force-push, or commit amendment.
- Incorporating work that appears after target capture.

If tracked content changes unexpectedly after target capture, abort and restore
branch from backup. Do not investigate or fix it in `/squash`.

## Phase A: immutable plan

### 1. Resolve base

```bash
ROOT=$(git rev-parse --show-toplevel)
BASE=$(python3 -c "
import json, os
reg = os.path.expanduser('~/.ion/worktree-registry.json')
root = os.path.realpath('$ROOT')
try: entries = json.load(open(reg)).get('entries', [])
except Exception: entries = []
for e in entries:
    if os.path.realpath(e.get('worktreePath', '')) == root:
        print(e.get('sourceBranch') or '')
        break
")
[ -n "$BASE" ] || BASE=main
git rev-parse --verify "$BASE"
```

Never substitute `main` when registry returned a missing named branch. Stop.

### 2. Guards

```bash
BRANCH=$(git branch --show-current)
[ "$BRANCH" != main ]
[ "$BRANCH" != "$BASE" ]
[ -z "$(git status --porcelain)" ]
COUNT=$(git rev-list --count "$BASE"..HEAD)
[ "$COUNT" -gt 1 ]
```

Otherwise stop with exact reason. Do not alter history.

### 3. Capture target and backup

```bash
TARGET_HEAD=$(git rev-parse HEAD)
TARGET_TREE=$(git rev-parse HEAD^{tree})
BASE_SHA=$(git rev-parse "$BASE")
BACKUP="backup--$BRANCH"
git branch -f "$BACKUP" HEAD
```

Record all four values. `TARGET_TREE` is immutable truth.

### 4. Read and group

Read every message and diff:

```bash
git log "$BASE"..HEAD --format=fuller --no-merges
git diff "$BASE"...HEAD --stat
git diff "$BASE"...HEAD
```

Group by logical feature. Feature count is logical groups. Physical commits are
one per versioned code scope (`engine`, `desktop`, `ios`, `relay`, `sdk`).
Feature docs may ride with matching feature commit. Cross-cutting docs use
`docs(repo)`.

Never mix code directories from different component scopes in one commit.

Detect shared files:

```bash
for f in $(git diff --name-only "$BASE"..HEAD); do
  echo "=== $f ==="
  git log "$BASE"..HEAD --oneline -- "$f"
done
```

Attribution:

- Linear, separable hunks: hunk split with `git add -p`; `e` forbidden.
- Cyclic/generated/high-risk file: whole file to last feature touching it.
- Ambiguous hunk: stop and `AskUserQuestion`. Never guess.

### 5. Emit plan only

```text
Base: <base> (<source>)
<N> source commits → <F> features → <M> result commits.

Features:
1. <description> — scopes: <scopes> [source SHAs]

Result commits:
1. type(scope): subject [feature N] [source SHAs]

Shared files:
- hunk-split: <file> — <owners>
- last-toucher: <file> → <feature> (<reason>)

Backup: <branch> at <TARGET_HEAD>
Target tree: <TARGET_TREE>
Reset target: <BASE> at <BASE_SHA>
```

Subjects only. No bodies or trailers except required issue `Fixes/Closes`.

Call `AskUserQuestion`:

- Question: `Proceed with this history-only squash plan?`
- Options: `Proceed`, `Adjust`, `Abort`

Do nothing until `Proceed`.

## Phase B: Git-only execution

### 6. Revalidate immutable target

Immediately before reset:

```bash
[ -z "$(git status --porcelain)" ]
[ "$(git rev-parse HEAD)" = "$TARGET_HEAD" ]
[ "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE" ]
[ "$(git rev-parse "$BACKUP"^{tree})" = "$TARGET_TREE" ]
```

Any mismatch: stop. Never absorb new work.

### 7. Soft reset and rebuild

```bash
git reset --soft "$BASE"
git reset
```

Working tree must remain target content. Build approved result commits in exact
plan order:

- Single-owner file: `git add <paths>`.
- Shared linear file: `git add -p <path>` using only `y`, `n`, `s`, `q`.
- Last-toucher file: leave unstaged until its assigned commit, then `git add`.

Before every commit:

```bash
git diff --cached --name-only
```

Verify staged code scope matches planned scope. Then:

```bash
git commit -m "type(scope): subject"
```

If a planned commit is empty, unexpected files remain, or attribution becomes
ambiguous: stop with `AskUserQuestion`. Never improvise.

### 8. Fail-closed verification

Let `PLANNED_COUNT` and ordered `PLANNED_SUBJECTS` come from approved plan.

```bash
[ -z "$(git status --porcelain)" ]
[ "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE" ]
[ "$(git rev-list --count "$BASE"..HEAD)" -eq "$PLANNED_COUNT" ]
git diff --exit-code "$BACKUP"
```

Compare exact ordered subjects:

```bash
git log "$BASE"..HEAD --reverse --format='%s'
```

Check each commit's code scope:

```bash
for sha in $(git log "$BASE"..HEAD --format='%H'); do
  subject=$(git log -1 --format='%s' "$sha")
  git diff-tree --no-commit-id --name-only -r "$sha"
  echo "$subject"
done
```

Any failure: restore branch pointer to backup and stop:

```bash
git reset --hard "$BACKUP"
```

Do not fix content.

## Final output

```text
Squash complete.

Branch: <branch>
Base: <base>
Target tree: <TARGET_TREE> (verified identical)
Before: <N> commits
After: <M> commits (<F> features)

<sha> <subject>

Backup: <backup> at <TARGET_HEAD>
```

STOP. Do not run tests, inspect failures, resume implementation, edit files,
push, or start another lifecycle command.
