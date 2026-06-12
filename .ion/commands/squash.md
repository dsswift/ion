---
description: Squash the current branch into clean conventional commits. Creates a backup branch first, reads all commits to understand logical groupings, generates a squash plan, executes the rebase. Does not push.
allowed-tools: Bash(git *)
---

You are running the `/squash` command. Your job is to collapse the current branch's commits into clean conventional commits — one per logical feature — using an interactive rebase. You create a backup branch first, generate a squash plan for review, and execute it.

**Hard rules.**

- Never run on `main`. Abort immediately if the current branch is `main`.
- Never run `git push`. Report that changes are ready to push.
- Preserve the full unsquashed history in the backup branch before squashing.
- Never fabricate commit messages. Every squashed commit message must be grounded in the actual commits being squashed.
- The squashed commits must follow conventional commit format exactly.
- **Every result commit must touch exactly one scope's directory tree.** A commit scoped `engine` must only contain files under `engine/`. A commit scoped `desktop` must only contain files under `desktop/`. And so on for `ios`, `relay`, `docs`. Commits scoped `repo` may only contain root-level files (`.github/`, `Makefile`, `AGENTS.md`, `scripts/`, `.ion/`, `README.md`, etc.) — they must **not** contain files under `engine/`, `desktop/`, `ios/`, `relay/`, or `docs/`. This rule exists because the CI/CD release pipeline (Release Damnit) uses commit scopes to detect which components changed and trigger version bumps. A single commit that bundles `engine/` and `desktop/` files under any scope will cause one component's version bump to be missed.

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

After grouping by feature, enforce the one-scope-per-commit rule. Each logical group produces **one result commit per scope directory** it touches, not one combined commit:

- If a group contains only `engine/` commits, it produces one `feat(engine)` commit.
- If a group contains `engine/`, `desktop/`, and `ios/` commits, it produces three result commits: `feat(engine)`, `feat(desktop)`, `feat(ios)`.
- If a group contains `engine/` commits and `docs/` commits, it produces `feat(engine)` + `docs(docs)`.
- Root-level files (`AGENTS.md`, `Makefile`, `.github/`, `scripts/`, `.ion/`, `README.md`) get their own `chore(repo)` or `docs(repo)` commit — they must not be bundled into a component scope commit.

To verify, run this check against every commit on the branch (including commits that won't be squashed):

```bash
for sha in $(git log main..HEAD --format="%H"); do
  subject=$(git log -1 --format="%s" $sha)
  scope=$(echo "$subject" | sed 's/[^(]*(\([^)]*\)).*/\1/')
  dirs=$(git diff-tree --no-commit-id --name-only -r $sha | awk -F/ '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "$scope | $dirs | $(echo $sha | cut -c1-8) $subject"
done
```

Flag any commit where the directories don't match the scope. Existing `repo`-scoped commits that touch component directories (`engine/`, `desktop/`, `ios/`, `relay/`, `docs/`) must be split during the rebase — they are not exempt.

The plan must list every result commit with its scope and the directories it will contain. No result commit may mix directories across scopes.

For each logical group, propose a clean conventional commit:
- `type(scope): description (#N)` — the conventional commit subject
- Body: a concise description of what this group of changes does and why
- Trailer: `Fixes #N` or `Closes #N` if the group is associated with a GitHub issue

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

Proceed with squash? (yes / adjust / abort)
```

Wait for the user to confirm before executing.

---

## Step 7: Execute the squash

When the user confirms (or after making any requested adjustments to the plan):

Use `git rebase -i main` to execute the squash. In the interactive rebase:
- The first commit in each logical group gets `pick`
- All subsequent commits in the group get `squash` or `fixup`
- Between groups, the next group's first commit gets `pick` again

After the rebase, amend each resulting commit to use the clean conventional message from the squash plan.

If the rebase produces conflicts, resolve them using the source commits as ground truth. Do not invent code — resolve conflicts by understanding what each commit was trying to do.

### Splitting multi-scope commits

Any commit that touches files from multiple scope directories must be split during the rebase. Mark it as `edit` instead of `pick`. When the rebase stops:

1. `git reset HEAD~1` — unstage all changes from that commit
2. Stage and commit files for each scope separately, in this order:
   - `git add engine/ && git commit -m "type(engine): ..."` — engine-only files
   - `git add desktop/ && git commit -m "type(desktop): ..."` — desktop-only files
   - `git add ios/ && git commit -m "type(ios): ..."` — iOS-only files
   - `git add docs/ && git commit -m "type(docs): ..."` — docs-only files
   - `git add relay/ && git commit -m "type(relay): ..."` — relay-only files
   - `git add . && git commit -m "type(repo): ..."` — any remaining root-level files
3. `git rebase --continue`

Issue references (`(#N)`) stay on all split children so GitHub cross-links work. `Closes #N` / `Fixes #N` trailers go only on the primary child (usually the engine commit).

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

Every commit must satisfy: the directories it touches are consistent with its declared scope. If any commit violates scope isolation, the squash is not complete — go back and split it.

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
