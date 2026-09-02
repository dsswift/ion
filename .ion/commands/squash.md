---
description: Rebuild a feature branch into clean conventional commits while preserving its exact final tracked tree.
model: standard
clears-conversation: true
---

# /squash

Rebuild current feature branch into clean conventional commits without changing
tracked content. This command is **history-only** and **fully autonomous**.

## No human interaction

Never call `AskUserQuestion`. Never pause for approval, confirmation, or
disambiguation at any point. Emit the plan, then execute it in the same turn
without waiting. Every decision has a deterministic rule below; when a rule
fires, apply it, log it as a plan revision, and continue.

The only stop conditions are the Phase A guards (§2), a pre-reset target
mismatch (§6), and verified content loss (§8). Once the rebuild starts it always
runs to completion (§7b) — a plan that proves unimplementable is revised, never
abandoned. Any stop is automatic and reported; it never asks.

## Absolute invariants

Two, both mandatory. Neither is ever traded for the other.

> **I1 — Content.** Final `HEAD^{tree}` must equal starting `HEAD^{tree}`
> byte-for-byte.
>
> **I2 — Scope.** Every result commit must resolve to exactly one scope under
> `.commit.json`, and its `type(scope):` tag must be that scope.

I2 is not cosmetic. Release-please versions each component by the **paths** a
commit touches (`release-please-config.json`), and takes the commit's type and
subject as that component's changelog entry. So a commit spanning two release
units bumps **both** and files the same subject under both changelogs — one of
them a lie. A commit whose tag disagrees with its paths ships a correct version
under a misleading entry. Both are defects equal in severity to losing content.

`.commit.json` keeps the tag and the paths in agreement, which is why scope is
always resolved from paths and never taken from the plan's subject line. There
is no "report the mismatch and move on" path: a scope violation is prevented
before commit (§7c) and repaired after commit (§8a).

Commit count, subjects, and grouping are all negotiable to satisfy I1 and I2.
Splitting a feature into more commits, or merging features into fewer, is always
permitted and preferred over shipping a wrong scope.

### Scope resolution — `.commit.json` is the only source of truth

**Never hardcode a scope list or a path mapping in this command.** The
repository already owns one at `<repo-root>/.commit.json`; a second copy here
would drift the moment a scope is added, and a stale map produces exactly the
mis-scoped commits I2 exists to prevent.

Load it once, at the start of Phase A, and use it for every scope decision:

```bash
SCOPE_MAP=$(cat "$ROOT/.commit.json")
```

Resolve a path to its scope by the file's own rules:

- Match the path against each `scopes[].path` prefix; the **longest** matching
  prefix wins, so a more specific entry always overrides a broader one.
- No prefix matches → `defaultScope`.
- Commit types come from `commitTypes.types`; use no type outside that list.

The set of valid scopes is exactly the `scope` values present in the file plus
`defaultScope`. If `.commit.json` is missing or unparseable, stop before the
soft reset with that exact reason — never fall back to a guessed map.

`.commit.json` maps paths to scopes; `commitlint.config.js` enumerates which
scopes are legal in a commit message. A scope resolved from the map that is
absent from the commitlint enum is a repository configuration defect: stop and
report it rather than committing a message the hook will reject.

A path that falls through to `defaultScope` while belonging to a component with
its own entry in `release-please-config.json` means `.commit.json` is missing a
mapping. `/squash` cannot edit files, so report it precisely — the resolved
path, the release unit it belongs to, and the `scopes[]` entry that would fix
it — and continue using `defaultScope` for this run.

### One scope per commit

Every result commit carries exactly one resolved scope. A commit whose staged
paths resolve to two different scopes is a violation regardless of which two —
there is no privileged pairing, and documentation does not ride along with the
code it documents. Docs paths resolve to their own scope and get their own
commit.

Never edit source. Never fix defects. Never resume prior implementation.
Never run builds, tests, formatters, generators, package managers, background
agents, or dependency commands. Never push.

Allowed operations:

- Read-only inspection: `git status`, `git log`, `git show`, `git diff`,
  `git diff-tree`, `git rev-parse`, `git rev-list`, `git branch`.
- History/staging: `git branch`, `git reset --soft`, `git reset`,
  `git restore --staged`, `git add`, `git add -p`, `git commit`.

Forbidden operations:

- `AskUserQuestion`, or any other prompt for operator input.
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
[ "$COUNT" -gt 0 ]
```

A single source commit is valid input. It can contain multiple resolved scopes or
carry a tag that does not match its paths, so rebuilding it can still require
multiple result commits. Only a branch with no commits above the base is a
no-op.

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
one per resolved scope, per § "Scope resolution".

Never mix two resolved scopes in one commit.

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
- Ambiguous hunk: do not guess and do not ask. Demote the whole file to
  last-toucher attribution — the entire file goes to the last feature touching
  it. Record the demotion in the plan under `Shared files` with reason
  `ambiguous`. This is deterministic and preserves the tree either way.

### 5. Emit plan, then continue

```text
Base: <base> (<source>)

Shared files:
- hunk-split: <file> — <owners>
- last-toucher: <file> → <feature> (<reason>)

Features:
1. <description> — scopes: <scopes> [source SHAs]

Result commits:
1. type(scope): subject [feature N] [source SHAs]

Backup: <branch> at <TARGET_HEAD>
Target tree: <TARGET_TREE>
Reset target: <BASE> at <BASE_SHA>

**<N>** source commits → <F> features → **<M>** result commits.
```

Subjects only. No bodies or trailers except required issue `Fixes/Closes`.

The plan is informational output, not a gate. Print it and move straight into
Phase B in the same turn. Do not ask whether to proceed. Do not wait.

## Phase B: Git-only execution

### 6. Revalidate immutable target

Immediately before reset:

```bash
[ -z "$(git status --porcelain)" ]
[ "$(git rev-parse HEAD)" = "$TARGET_HEAD" ]
[ "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE" ]
[ "$(git rev-parse "$BACKUP"^{tree})" = "$TARGET_TREE" ]
```

Any mismatch: stop and report. Never absorb new work, never ask. Nothing has
been rewritten yet, so no restore is needed.

### 7. Soft reset and rebuild

```bash
git reset --soft "$BASE"
git reset
```

**Past this point the rebuild always completes.** The soft reset left the full
target content in the working tree, so every remaining file is present and a
valid commit sequence always exists. There is no state from here that justifies
abandoning the rebuild — see §7b.

Working tree must remain target content. Build the planned result commits in
exact plan order:

- Single-owner file: `git add <paths>`.
- Shared linear file: `git add -p <path>` using only `y`, `n`, `s`, `q`.
- Last-toucher file: leave unstaged until its assigned commit, then `git add`.

### 7c. Mandatory pre-commit scope gate

**No `git commit` runs until this gate passes.** It is the primary enforcement
of I2 — cheaper and safer than repairing after the fact.

```bash
git diff --cached --name-only
```

Resolve every staged path to a scope through `SCOPE_MAP`. Then:

1. **Count the distinct resolved scopes.**
   - Exactly one → continue.
   - Two or more → **do not commit.** Unstage every path outside the first
     scope in `scopes[]` declaration order, commit that scope, then repeat the
     gate for each remaining scope with the same subject and its own tag.
     Record a `Plan revision:` line.
2. **Confirm the tag equals the resolved scope.** If the planned subject says
   `fix(desktop)` and the paths resolve to `engine`, the *tag* is wrong, not the
   content — commit with the resolved scope. The map wins over the plan, always.
3. **Confirm the type is in `commitTypes.types`.** Substitute the nearest
   allowed type if not; never invent one.

Only after all three pass:

```bash
git commit -m "type(scope): subject"
```

Then re-derive from the commit itself as a self-check:

```bash
git diff-tree --no-commit-id --name-only -r HEAD
git log -1 --format='%s'
```

A disagreement here means the gate was misapplied — repair immediately via §8a
while it is the newest commit and the repair is a single soft reset.

### 7a. Deterministic in-flight corrections

Execution deviations are resolved by rule, never by asking. Apply the matching
rule, print a `Plan revision:` line naming the rule and the affected paths, and
continue. The revised plan becomes `FINAL_PLAN` for §8.

| Condition | Rule |
|---|---|
| Staged set for one planned commit spans multiple resolved scopes | Split it: one commit per scope in `scopes[]` declaration order, each keeping the feature's subject with its own resolved tag. Do not ask; I2 requires it. |
| A file must move to a different scope's commit than planned | Move it to the commit owning its scope. If none exists, append a commit for that scope at the feature's position. |
| A planned commit stages empty | Drop it from `FINAL_PLAN`. |
| Files remain unstaged after the last planned commit | Attribute each to the last feature touching it, grouped by scope, as trailing commits in scope order. |
| Hunk attribution turns ambiguous mid-`add -p` | `q` out, `git reset` that path, and take the whole file under last-toucher attribution. |
| `git add -p` stages more, fewer, or different hunks than planned | Do not abort. `git reset` that path and take the whole file under last-toucher attribution. |
| A commit's staged content is logically incomplete (decode without handler, type without consumer, code without its test) | **Not an abort condition.** Either widen this commit to include the missing paths, or let them ride in the commit that ends up owning them. Intermediate commits are not required to build, compile, typecheck, or be self-consistent. |

### 7b. No dead ends

An intermediate commit is not a deliverable. `/squash` guarantees exactly one
thing — the final tree — and guarantees nothing about any commit before the last
one. Partial staging, a split-up file, a commit that would not compile in
isolation, or a plan that stops matching reality are all **expected** outcomes of
hunk splitting, not failures.

Never restore from backup because the plan proved unimplementable as written.
When no §7a rule fits, descend this ladder until something works, printing a
`Plan revision:` line at each step:

1. Widen the current commit to include whatever paths make it coherent —
   **within one scope only.**
2. Drop hunk splitting for the problem file; assign the whole file to one commit.
3. Merge the affected features into a single commit per scope.
4. **Terminal fallback, always available:** stage everything remaining and emit
   one commit per resolved scope in `scopes[]` declaration order, subject taken
   from the dominant feature for that scope. Repeat until `git status --porcelain` is empty.

Every step routes through the §7c gate, so **no ladder step may merge two
resolved scopes into one commit.** Feature grouping degrades under this ladder;
scope purity never does. Step 4 cannot fail — every file is already in the
working tree — so the rebuild has no unreachable state. A squash with coarser
feature grouping beats a rollback; a squash with a wrong scope does not.

The only mid-rebuild condition that stops execution is loss of target content
(`git status` clean while `HEAD^{tree}` differs from `TARGET_TREE`), which means
content vanished rather than a plan mismatch. That is §8's business.

### 8. Fail-closed verification

Let `PLANNED_COUNT` and ordered `PLANNED_SUBJECTS` come from `FINAL_PLAN` — the
emitted plan plus every §7a revision.

```bash
[ -z "$(git status --porcelain)" ]
[ "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE" ]
[ "$(git rev-list --count "$BASE"..HEAD)" -eq "$PLANNED_COUNT" ]
git diff --exit-code "$BACKUP"
```

Classify a failure before reacting — most are repairable, and repair is the
required first response:

| Failure | Response |
|---|---|
| `git status` not clean | **Repair.** Uncommitted target content remains. Run §7b step 4 on the remainder, then re-verify. |
| Commit count differs from `PLANNED_COUNT` | **Not a failure.** §7a/§7b revisions changed the count legitimately. Update `FINAL_PLAN` to the actual commits and re-verify the rest. |
| Ordered subjects differ from `FINAL_PLAN` | **Not a failure.** Reconcile `FINAL_PLAN` to what was built and report it. |
| A commit's tag does not match its resolved scope, or a commit spans two resolved scopes | **Repair via §8a.** Never report-and-ship; I2 is absolute. |
| `git status` clean **and** `HEAD^{tree}` ≠ `TARGET_TREE`, or `git diff --exit-code "$BACKUP"` non-empty | **Restore.** Content was lost. This is the only unrepairable state. |

Re-verify after any repair. Repair loops at most three times, then restore. A
scope violation that somehow survives three §8a rewinds is treated as unsafe and
restored — shipping a wrong scope is never an acceptable outcome.

Compare exact ordered subjects:

```bash
git log "$BASE"..HEAD --reverse --format='%s'
```

Audit every commit's scope — this check is mandatory and never skipped:

```bash
for sha in $(git log "$BASE"..HEAD --format='%H'); do
  subject=$(git log -1 --format='%s' "$sha")
  git diff-tree --no-commit-id --name-only -r "$sha"
  echo "$subject"
done
```

For each commit, resolve its paths through `SCOPE_MAP` and compare against its
tag. Any commit spanning two resolved scopes, or carrying a tag that does not
equal its resolved scope, goes to §8a.

### 8a. Scope repair by rewind and rebuild

A committed scope violation is repairable — `git reset --soft` never touches the
working tree, so rewinding to before the offending commit and rebuilding forward
preserves I1 exactly.

Let `BAD` be the **earliest** commit failing the scope audit:

```bash
BAD_PARENT=$(git rev-parse "$BAD"^)
git reset --soft "$BAD_PARENT"
git reset
```

Everything from `BAD` onward is now unstaged working-tree content, fully intact.
Rebuild those commits forward through the §7c gate, splitting by derived scope
where the original spanned two. Commit count will grow; that is correct and
expected. Print a `Plan revision:` line naming the rewind and the resulting
split, then return to §8 and re-verify from the top.

This is a rewind, not an amendment or a rebase — the forbidden-operations list
still holds. `git reset --soft` is explicitly allowed, and content is never at
risk because the working tree is untouched throughout.

Only a **Restore** row above reaches this step — content loss, nothing else.
Restore the branch pointer to backup immediately and stop, without asking.

```bash
git reset --hard "$BACKUP"
```

Then confirm the restore and report which check failed:

```bash
[ "$(git rev-parse HEAD)" = "$TARGET_HEAD" ]
[ "$(git rev-parse HEAD^{tree})" = "$TARGET_TREE" ]
```

Do not fix content. Do not retry. Do not ask.

## Final output

```text
Squash complete.

Branch: <branch>
Base: <base>
Target tree: <TARGET_TREE> (verified identical)
Scope audit: all <M> commits single-scope, tags match paths
<sha> <subject>

Backup: <backup> at <TARGET_HEAD>
Plan revisions: <none | one line per §7a/§7b rule applied>

Before: **<N>** commits
After: **<M>** commits (<F> features)
```

STOP. Do not run tests, inspect failures, resume implementation, edit files,
push, or start another lifecycle command.
