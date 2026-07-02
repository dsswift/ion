---
description: Squash the current branch into clean conventional commits. Creates a backup branch first, reads all commits to understand logical groupings, generates a squash plan, executes the rebase. Does not push.
---

You are running the `/squash` command. Your job is to collapse the current branch's commits into clean conventional commits — one per logical feature — using an interactive rebase. You create a backup branch first, generate a squash plan for review, and execute it.

**Interaction rule.**

Any point where the protocol needs a human decision MUST be a single `AskUserQuestion` tool call. Never end a turn on a decision-shaped question written as prose: a prose question followed by `end_turn` leaves the session idle with nothing to wait on, and the run stalls. This applies to scripted gates (Step 6's proceed/adjust/abort confirmation) AND to any unscripted fork discovered mid-execution (e.g. an execution-method choice surfaced during conflict analysis in Step 7).

**Hard rules.**

- Never run on `main`. Abort immediately if the current branch is `main`.
- Never run `git push`. Report that changes are ready to push.
- Preserve the full unsquashed history in the backup branch before squashing.
- Never fabricate commit messages. Every squashed commit message must be grounded in the actual commits being squashed.
- The squashed commits must follow conventional commit format exactly.
- **Code scope isolation is mandatory; documentation may ride anywhere.** The scope-isolation rule applies to **code** files under a versioned component directory (`engine/`, `desktop/`, `relay/`, `ios/`): a commit scoped `engine` must not contain `desktop/` *code*, a commit scoped `desktop` must not contain `engine/` *code*, and so on. **Documentation files (`*.md`, anything under `docs/`) are exempt** — they do not trigger releases and may ride in any commit. Feature documentation bundles into its feature's commit (a `docs/` file under a `feat(engine)` commit is correct); only documentation *not* associated with a feature (e.g. cross-cutting `AGENTS.md` behavior changes) becomes a standalone `docs(repo)` commit, which may span directories.

  **Why the distinction exists.** Scopes exist *only* to drive independent component builds and version bumps. A `feat(engine)` + `feat(desktop)` pair triggers both the engine build and the desktop build to produce new releases. A `docs`-type (or `repo`-type) commit triggers no build and no version bump — it does not touch the release pipeline at all. So documentation cannot build or version anything, which means its placement relative to commit scope is irrelevant to the only thing scopes are for. The single failure mode the rule guards against is a *code* file under a versioned component directory riding in a commit whose scope doesn't match that directory — that is what makes a component's build fail to trigger (the CI/CD release pipeline, Release Damnit, uses commit scopes to detect which components changed). A bundled `docs/` file never causes that.

---

## Step 1: Check the branch

Run:

```bash
git branch --show-current
```

If the result is `main`, stop immediately:

> Cannot squash on `main`. Switch to a feature branch first.

Do nothing else.

---

## Step 2: Check for pending work

Run:

```bash
git status --porcelain
```

If there are uncommitted changes (staged or unstaged), stop:

> There are uncommitted changes on this branch. Commit or stash them before squashing.

---

## Step 3: Create or update the backup branch

Run:

```bash
git branch --show-current
```

The backup branch name is `backup--{branch_name}`.

Check if it already exists:

```bash
git branch --list backup--{branch_name}
```

If it exists, move it to the current HEAD:

```bash
git branch -f backup--{branch_name} HEAD
```

If it does not exist, create it:

```bash
git branch backup--{branch_name} HEAD
```

Report: "Backup branch `backup--{branch_name}` is now pointing to `{HEAD SHA}`."

---

## Step 4: Count commits ahead of main

Run:

```bash
git log main..HEAD --oneline
```

Count the commits. If there is exactly one commit, stop:

> Nothing to squash — the branch has a single commit. No action taken.

Print the list of commits so the user can see what's on the branch.

---

## Step 5: Read all commit messages

Run:

```bash
git log main..HEAD --format=fuller --no-merges
```

Read every commit message in full: subject, body, and trailers. The commit messages are the source of truth for understanding the logical groupings. Do not infer groupings from file paths alone — read the messages.

---

## Step 6: Generate the squash plan

Analyze the commits and identify logical groupings. A logical group is a set of commits that all implement a single feature, fix, or task. Rules:

- Commits that implement the same feature belong in one group, even if they were made separately (e.g. the initial implementation, a fix, and a test addition).
- Alignment fixes that address a specific feature belong with that feature's group.
- Unrelated changes stay in separate groups.
- The order of groups should be chronological (oldest first).

### Scope enforcement

After grouping by feature, enforce **code** scope isolation: each logical group produces **one result commit per code scope directory** it touches. Documentation files (`*.md`, `docs/`) are not scope-isolated and bundle into the feature commit they document (see "Documentation bundling" below).

- If a group contains only `engine/` code, it produces one `feat(engine)` commit.
- If a group contains `engine/`, `desktop/`, and `ios/` code, it produces three result commits: `feat(engine)`, `feat(desktop)`, `feat(ios)`.
- If a group contains `engine/` code plus a `docs/` file documenting that engine feature, it produces a single `feat(engine)` commit that **includes** the `docs/` file — not a separate `docs(docs)` commit.
- Root-level config/build files (`Makefile`, `.github/`, `scripts/`, `.ion/`) that are not feature documentation get their own `chore(repo)` commit — they must not be bundled into a component scope commit alongside that component's code.

#### Documentation bundling

Documentation does not build or version anything, so where a doc file sits relative to commit scope is irrelevant to the release pipeline. Apply this policy:

- **Feature documentation rides with its feature commit.** If `docs/configuration/engine-json.md` documents the engine feature in this group, that doc edit belongs *in* the `feat(engine)` commit. Do **not** pull it into a separate docs commit.
- **When a feature spans multiple scopes** (e.g. desktop + iOS), feature docs may be bundled into *either* scope's commit — it doesn't matter which. If the docs split cleanly per scope (a desktop-specific doc file and a separate iOS-specific doc file), bundle each with its matching scope. If one shared doc file applies to both, attach it to either one.
- **Only documentation not associated with any feature** becomes a standalone `docs(repo)` commit. The canonical case is cross-cutting `AGENTS.md` behavior/governance changes: edited all at once, tied to no single feature, a repo-level concern. Such a commit may span directories (root `AGENTS.md` + `engine/AGENTS.md` + `desktop/AGENTS.md` + `ios/AGENTS.md` collapse into **one** `docs(repo)` commit, not four).

To verify, run this check against every commit on the branch (including commits that won't be squashed):

```bash
for sha in $(git log main..HEAD --format="%H"); do
  subject=$(git log -1 --format="%s" $sha)
  scope=$(echo "$subject" | sed 's/[^(]*(\([^)]*\)).*/\1/')
  dirs=$(git diff-tree --no-commit-id --name-only -r $sha | awk -F/ '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "$scope | $dirs | $(echo $sha | cut -c1-8) $subject"
done
```

Flag any commit where a **code** directory doesn't match the scope — that is the versioning-critical violation that must be split during the rebase. The script will *also* show multi-dir output for a feature commit carrying a `docs/` file (e.g. `engine | docs,engine`) or for a `docs(repo)` commit spanning directories — those flags are **expected and acceptable**, not violations, because documentation is versioning-inert. The check only matters for code under a mismatched scope.

The plan must list every result commit with its scope and the directories it will contain. No result commit may mix **code** directories across scopes; documentation directories riding alongside a feature (or spanning a `docs(repo)` commit) are fine.

For each logical group, propose a clean conventional commit:
- `type(scope): description (#N)` — the conventional commit subject
- Body: a concise description of what this group of changes does and why
- Trailer: `Fixes #N` or `Closes #N` if the group is associated with a GitHub issue

### Cross-feature shared files

Do not assume feature groups map to disjoint sets of files. The same file is frequently edited by **two or more different feature groups** across separate source commits. Detect this **before** finalizing the plan, because it changes how the rebase must be executed (Step 7).

Detect shared files: for every file changed on the branch, list which source commits touched it. Any file touched by commits that you've assigned to *different* result groups is a **cross-feature shared file**.

```bash
# For each changed file, show the source commits that touched it.
# A file listed under commits from different feature groups is shared.
for f in $(git diff --name-only main..HEAD); do
  echo "=== $f ==="
  git log main..HEAD --oneline -- "$f"
done
```

**Default policy: hunk-level precise split.** A shared file's individual hunks belong to the feature that introduced them. Do **not** assign the whole file to one feature: the final file state is the union of every feature's hunks, so a whole-file assignment leaves the other features' commits missing their contribution and produces logically wrong commits. Each hunk rides in the commit of the feature that authored it.

This is the only correct attribution. The deeper reason: when two genuinely different features both edit the same file, the final file content contains both features' changes; only hunk-level splitting attributes each change to the right commit. Whole-file or "latest-commit-wins" path-staging cannot do this — **do not** rebuild the branch by staging whole files per path; that scatters a feature's hunks into unrelated later commits. Use the interactive rebase + hunk-staging method in Step 7.

Note in the plan which files are shared and which result commits will split their hunks, so the user sees the attribution before approving.

Present the squash plan to the user:

```
Squash plan:

{N} commits -> {M} clean commits

Logical group 1: {description}
  Commits: {list of short SHAs and subjects being squashed}
  Result commit: {proposed commit subject}

Logical group 2: {description}
  Commits: {list}
  Result commit: {proposed commit subject}

...

Backup branch `backup--{branch_name}` is pointing to current HEAD.
The full unsquashed history is preserved there.
```

After presenting the plan, call `AskUserQuestion` with the question "Proceed with the squash as planned?" and options: `Proceed`, `Adjust`, `Abort`. Do not execute the rebase until the user selects `Proceed`.

---

## Step 7: Execute the squash

When the user selects `Proceed` (or after making any requested adjustments to the plan):

Use `git rebase -i main` to execute the squash. In the interactive rebase:
- The first commit in each logical group gets `pick`
- All subsequent commits in the group get `squash` or `fixup`
- Between groups, the next group's first commit gets `pick` again

After the rebase, amend each resulting commit to use the clean conventional message from the squash plan.

If the rebase produces conflicts, resolve them using the source commits as ground truth. Do not invent code — resolve conflicts by understanding what each commit was trying to do.

**Unscripted method forks during execution.** If conflict analysis or an unexpected situation surfaces a genuine choice (for example: the actual hunk attribution is ambiguous between two attributions, or a conflict cannot be resolved without a strategy decision), do not proceed on a default and say "I'll do X unless you object." Stop and call `AskUserQuestion` with the specific choice and options. The interaction rule applies here exactly as it does at scripted gates.

### Splitting multi-scope code commits

Only commits that touch **code** files from multiple *code* scope directories (`engine/`, `desktop/`, `ios/`, `relay/`) must be split during the rebase — that is the versioning-critical case. A commit whose multi-directory footprint is **documentation** (a `docs/` file riding with a feature, or `AGENTS.md` files spanning directories) does **not** need splitting: documentation is versioning-inert and bundles with its feature (or collapses into one `docs(repo)` commit). Mark a code-multi-scope commit as `edit` instead of `pick`. When the rebase stops:

1. `git reset HEAD~1` — unstage all changes from that commit
2. Stage and commit files for each code scope separately, in this order. Feature documentation may stay with its feature's code slice (e.g. `docs/configuration/engine-json.md` committed alongside the engine code) rather than being carved into a separate docs commit:
   - `git add engine/ && git commit -m "type(engine): ..."` — engine files (plus any feature docs for the engine feature)
   - `git add desktop/ && git commit -m "type(desktop): ..."` — desktop files
   - `git add ios/ && git commit -m "type(ios): ..."` — iOS files
   - `git add relay/ && git commit -m "type(relay): ..."` — relay files
   - `git add . && git commit -m "type(repo): ..."` — remaining root-level / unassociated-docs files (`docs(repo)` for standalone documentation)
3. `git rebase --continue`

Issue references (`(#N)`) stay on all split children so GitHub cross-links work. `Closes #N` / `Fixes #N` trailers go only on the primary child (usually the engine commit).

### Splitting a cross-feature shared file (hunk-level)

A file edited by two or more different feature groups (detected in Step 6) needs **hunk-level** attribution — a *different* operation from the scope-directory split above. The scope split assigns whole files by their directory; hunk splitting divides a *single* file's diff between commits because each feature authored only part of it.

For a result commit that must claim only *some* hunks of a shared file, mark the relevant source commit `edit`. When the rebase stops:

1. `git reset HEAD~1` — unstage the commit's changes
2. `git add -p <shared-file>` — interactively stage **only** this feature's hunks (use `s` to split a hunk, `e` to edit it by hand when hunks are adjacent). Stage whole files normally for any non-shared file in the same commit.
3. `git commit -m "type(scope): ..."` — commits this feature's hunks; the remaining hunks stay in the working tree for the next group's commit.
4. `git rebase --continue`

**Do not** rebuild the branch by staging whole files per path ("latest-claimant" path-staging) — it scatters a feature's hunks into unrelated later commits and produces logically wrong commits. The interactive rebase with `git add -p` is the only method that attributes hunks correctly.

Hunk-splitting is orthogonal to scope-splitting: a shared file within a single scope still needs hunk attribution; a shared file that also spans code scopes needs both. Whatever the attribution, the Step 8 tree-identity check is the non-negotiable backstop — hunk attribution changes *which commit* owns a hunk, never the final tree.

---

## Step 8: Verify

After the rebase completes:

```bash
git log main..HEAD --oneline
```

Verify the output matches the squash plan: correct number of commits, correct subjects.

```bash
git log main..HEAD --format=fuller
```

Verify trailers are present on each commit that had an issue association.

### Verify scope isolation

Run the scope check against every result commit:

```bash
for sha in $(git log main..HEAD --format="%H"); do
  subject=$(git log -1 --format="%s" $sha)
  scope=$(echo "$subject" | sed 's/[^(]*(\([^)]*\)).*/\1/')
  dirs=$(git diff-tree --no-commit-id --name-only -r $sha | awk -F/ '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "$scope | $dirs | $(echo $sha | cut -c1-8) $subject"
done
```

Apply the pass condition by file type, not by raw directory count:

- A commit containing a versioned-component **code** file (`engine/`, `desktop/`, `ios/`, `relay/`) under a **mismatched** scope **fails** — go back and split it (Step 7). This is the only scope violation that matters.
- A feature commit that also carries its own `docs/` file (e.g. `engine | docs,engine`) **passes** — feature documentation legitimately rides with its feature.
- A standalone `docs(repo)` commit spanning multiple directories (e.g. the `AGENTS.md` collapse) **passes** — documentation is versioning-inert.

The script flagging a docs-bearing feature commit or a multi-directory documentation commit as multi-dir is **expected**, not a failure. Only a code file under the wrong scope blocks completion.

### Verify tree identity

The final tree must be identical to the pre-squash tree:

```bash
git diff backup--{branch_name}
```

If this produces any output, the squash changed the code — which is a bug. Abort and investigate.

---

## Step 9: Report

```
Squash complete.

Branch: {branch name}
Before: {N} commits
After: {M} commits

Result commits:
  {list of new commit SHAs and subjects}

Backup: backup--{branch_name} at {SHA} (full pre-squash history preserved)

No git push was run.
Next step: /create-pr to push and open the pull request.
```
