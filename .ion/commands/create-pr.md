---
clears-conversation: true
description: Push the current branch and open a pull request into main with a structured description derived from the branch's commits and the open issues it resolves.
model: fast
---

# /create-pr

Push the current feature branch and open a pull request into `main`. The title and body come from the branch's commits and the issues they resolve.

## Rules

- This command is the one place `git push` runs. It pushes the feature branch and nothing else.
- The operator merges. This command opens the PR and stops.
- The PR is a real PR, not a draft, so it gets review coverage.
- Every failure a check in this command surfaces is fixed before the PR opens. CI (`.github/workflows/quality.yml`) is expected to be green.
- Issue closure is resolved in Step 7 on every run, by matching open issues against the branch.

---

## Step 1: Validate the branch

```bash
git branch --show-current
```

If the result is `main`, stop:

> You're on `main`. Switch to a feature branch before creating a PR.

## Step 2: Check for uncommitted work

```bash
git status --porcelain
```

If there are uncommitted changes, stop:

> There are uncommitted changes on this branch. Commit them before opening a PR.

## Step 2b: Rebase onto the latest `main` and read the diff

```bash
git fetch origin main
git rebase origin/main
```

The parity gate then tests what `main` will receive. On a conflict, resolve it when both sides make the intent plain, then continue the rebase. When the resolution needs a decision, run `git rebase --abort` and stop with the conflicting files named.

Read what the PR will carry:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Check the whole diff against what the commits say they do. Debug output, stray files, edits unrelated to the goal, and secret values are removed in a commit, and the command starts again from Step 2.

---

## Step 3: Linux parity gate

CI runs the engine, desktop, and server suites on `ubuntu-latest`. Development is on macOS, so path semantics, file-watcher timing, locale, and race-detector scheduling can pass locally and fail in CI. This step runs the same commands in Linux containers.

### 3a. Determine the gates

```bash
git diff origin/main...HEAD --name-only
```

| A changed path under | Gates |
|---|---|
| `engine/` | `make test-linux-engine` |
| `desktop/` | `make test-linux-desktop` |
| `server/` | `make test-linux-server`, `make test-linux-desktop` |
| `packages/` | `make test-linux-server`, `make test-linux-desktop` |

The server gate runs the shared-package and server suites. The desktop gate builds both renderer bundles, which bundle server and shared code.

With no path in the table, skip to Step 3e.

### 3b. Docker preflight

```bash
docker info
```

If `docker` is missing or the daemon is not running, call `AskUserQuestion` with "Docker isn't running, so I can't run the Linux parity check locally before pushing. How would you like to proceed?" and the options `Start Docker and continue` and `Proceed without Docker`.

- `Start Docker and continue`: wait for the operator to confirm, then continue at 3c.
- `Proceed without Docker`: go to Step 3e and record in the report that the Linux gate was skipped. The PR's own CI jobs still guard the merge.

### 3c. Dispatch the gates in the background

Each gate runs a container for several minutes, longer than a foreground tool call allows. Dispatch each one as its own call with `Bash({ run_in_background: true, notify_on_complete: true })`, all in the same turn, so they run at the same time.

Then end the turn. The engine resumes the conversation with each result when its container exits (`docs/tools/task-tools.md` § "Background bash completion").

If a call reports that background execution is unavailable, run that gate in the foreground and record that in the report.

### 3d. Act on the result

| Result | Action |
|---|---|
| Every dispatched gate passed | Continue to Step 3e |
| A gate failed | Fix every failure it surfaced, dispatch the same gate again, and wait for the result |
| A failure needs a product decision | Stop and put the decision to the operator |

### 3e. iOS gate

Run this when a changed path is under `ios/`, or is `scripts/run-ios-tests.sh`, `Makefile`, or `.github/workflows/quality.yml`.

```bash
make ios-pr-check
make ios-test
```

On a failure, fix it and run both again.

---

## Step 4: Push the branch

```bash
git push --force-with-lease -u origin {branch}
```

The rebase in Step 2b rewrites a branch that was pushed before, so a plain push would be rejected. `--force-with-lease` refuses when the remote holds commits this machine has not seen.

If the push fails, report the error and stop.

## Step 5: Check for an existing PR

```bash
gh pr view {branch} --json number,url,state 2>/dev/null
```

`gh pr view` returns the most recent PR for the branch in any state. Only `"OPEN"` counts as existing.

If an open PR exists, show its number and URL and ask: "A PR already exists for this branch. Want to update its title/body instead?" On yes, Step 10 uses `gh pr edit {number} --title "..." --body "..."`.

## Step 6: Collect commits

```bash
git log origin/main..HEAD --oneline --no-merges
git log origin/main..HEAD --no-merges --format="### %s%n%n%b"
```

With zero commits ahead of `main`, stop: "Nothing to open a PR for — branch is even with `main`."

---

## Step 7: Resolve issue closure

A PR closes an issue only through a closing keyword in its body. `scripts/check-issue-closure.sh` validates the `(#N)` references that exist, so a branch with no references passes that gate and closes nothing. This step finds the issues the branch resolves, whether or not a commit names them.

Collect what the commits carry:

```bash
git log origin/main..HEAD --no-merges --format="%s%n%b" \
  | grep -oiE '\(#[0-9]+\)|\b(fix(e[sd])?|close[sd]?|resolve[sd]?)[[:space:]]+#[0-9]+'
```

List the open issues:

```bash
gh issue list --state open --limit 100 --json number,title --jq '.[] | "#\(.number) \(.title)"'
```

Read the commit subjects and bodies against the issue titles. An issue matches when the branch implements the behavior the issue asks for.

Present the result:

```
Issues this PR closes:
  #397  [desktop] Add a configurable metadata-driven graph view   (matched: Graph View commits)
  #380  [sdk] Carry child conversation identifier on dispatch     (explicit: Closes #380 in commit body)

Add any I missed, or reply "none" to confirm.
```

With no match and no references, say `No open issue matches this branch.`

Wait for the operator's answer in both cases. Every confirmed number becomes a closing keyword in Step 9.

---

## Step 8: Generate the PR title

The title lands in `main`'s history. Follow the convention recent merged PRs and the log show:

```bash
gh pr list --state merged --limit 20 --json title --jq '.[].title'
git log origin/main --no-merges --format=%s -20
```

Use conventional-commit format with a scope. Say what changes for the person using Ion and why it matters.

- One commit: start from its subject. Rewrite it when it only names areas.
- Several commits for one change across components: name that change.
- Several distinct changes: name what the PR achieves as a whole.
- When the commits reference an issue (`#N`), include it.

BAD
> ❌ fix: Windows release manifest, tab persistence, and injection classification

GOOD
> ✅ fix(engine): stop recalled dispatch callbacks from restarting stopped sessions

## Step 9: Generate the PR body

Read each issue confirmed in Step 7:

```bash
gh issue view {N} --json title,body
```

Open with the problem in plain words, as a user saw it, taken from the issues and the commit bodies. Then say briefly how this PR fixes it.

```markdown
{The problem, as a user saw it. One to three sentences.}

{How this fixes it. A few sentences. Name the components when several are touched: engine, server, desktop, ios, relay.}

Fixes #N
```

BAD
> ❌ Track root-level dispatch identities from launch through their terminal
> callback (`rootDispatchIDs`), since the dispatch registry deregisters before
> invoking that callback.

GOOD, the same PR written for a reader:
> ✅ Stopping a session did not always stick. A background agent that finished
> after the stop could start the conversation again. Now a stopped session stays
> stopped.

- Write for the maintainer, collaborators, and the public. Inform; do not sell.
- The body leads with the problem, not with files, functions, or internal names.
- Each issue confirmed in Step 7 gets a closing keyword at the end of the body, one per line: `Fixes` for bug work, `Closes` for feature work. A `(#N)` in a title or subject is a link and closes nothing.
- The body carries no raw commit hashes.

```
Fixes #142
Closes #138
```

## Step 10: Create the PR

```bash
gh pr create --base main --title "{title}" --body "{body}"
```

## Step 11: Report

```
✅ PR #{number} created: {URL}
   {title}
   {N} commits, scopes: {list}
   Linux parity gate: passed (background) | passed (foreground) | skipped (Docker down, operator chose to proceed) | n/a (no engine, server, desktop, or packages changes)

Next step: Wait for CI. When it passes, the PR is ready to merge.
```

When an existing PR was updated, the first line reads `✅ PR #{number} updated: {URL}` and the "Next step" line is omitted.
