---
description: Push the current branch and open a pull request into main with a structured description derived from the branch's commits and issue references.
allowed-tools: Bash(git *), Bash(gh pr *), Bash(gh issue view *)
---

You are running the `/create-pr` command. Your job is to push the current feature branch and open a pull request into `main` with a well-structured description. The PR title and body are derived from the branch's commits and the issues they reference.

**Hard rules.**

- Never run on `main`. Abort if the current branch is `main`.
- Only run `git push` as part of this command. No other `git push` outside this flow.
- Never merge to `main`. The PR is opened — the user merges.
- Do not create a PR with failing CI. If CI is already known to be failing, stop and report.

---

## Step 1: Validate the branch

Run:

```bash
git branch --show-current
```

If the result is `main`, stop:

> You're on `main`. Switch to a feature branch before creating a PR.

---

## Step 2: Check for uncommitted work

Run:

```bash
git status --porcelain
```

If there are uncommitted changes, stop:

> There are uncommitted changes on this branch. Commit them before opening a PR.

---

## Step 3: Push the branch

```bash
git push -u origin {branch}
```

If the push fails, report the error and stop.

---

## Step 4: Check for an existing PR

```bash
gh pr view {branch} --json number,url,state 2>/dev/null
```

`gh pr view` returns the most recent PR for the branch regardless of state. Only treat it as an existing PR if `state` is `"OPEN"`. If the state is `"MERGED"` or `"CLOSED"`, ignore it and proceed to create a new PR.

If an open PR already exists:
- Show its number and URL
- Ask: "A PR already exists for this branch. Want to update its title/body instead?"
- If yes, use `gh pr edit {number} --title "..." --body "..."` instead of `gh pr create`

---

## Step 5: Collect commits

Gather the commits on this branch:

```bash
git log main..{branch} --oneline --no-merges
git log main..{branch} --no-merges --format="### %s%n%n%b"
```

If there are zero commits ahead of `main`, abort: "Nothing to open a PR for — branch is even with `main`."

Also collect issue references from commit bodies:

```bash
git log main..{branch} --no-merges --format="%b" | grep -E "Fixes|Closes"
```

---

## Step 6: Generate the PR title

Analyze the commits and write the PR title.

Rules:
- If there is a single commit, use its subject line as the PR title.
- If there are multiple commits that all implement the same change across components (e.g. one engine commit and one desktop commit), write a title that captures the unified feature — use the shared subject as a base.
- If there are multiple distinct changes, write a descriptive title that tells reviewers what the PR does at a glance. No character limit on PR titles — be as descriptive as needed.
- If the commits reference a GitHub issue (`#N`), include it in the title: `Wire agent_start / agent_end hooks (#126)`.
- Do not force conventional-commit format on the PR title. PR titles are human-readable summaries, not commit subjects.

---

## Step 7: Generate the PR body

Write a concise PR description:

```markdown
## Summary

{1-3 sentence overview of what this PR does and why}

## Changes

{bulleted list of changes, grouped by scope if multiple scopes are touched}

- **engine:** description
- **desktop:** description
- **ios:** description
```

Rules:
- Write for the repo maintainer, collaborators, and public. No selling — just inform.
- Be informative, not exhaustive. A clear summary and a clean list is enough.
- If any commit body contains `Fixes #N` or `Closes #N`, include that trailer at the very end of the body, on its own line. Collect all such references:

```
Fixes #142
Closes #138
```

- Do not include raw commit hashes in the body.
- Do not repeat the summary in the changes list.

---

## Step 8: Create the PR

```bash
gh pr create --base main --title "{title}" --body "{body}"
```

---

## Step 9: Report

```
✅ PR #{number} created: {URL}
   {title}
   {N} commits, scopes: {list}

Next step: Wait for CI. When it passes, the PR is ready to merge.
```

If an existing PR was updated instead:

```
✅ PR #{number} updated: {URL}
   {title}
   {N} commits, scopes: {list}
```
