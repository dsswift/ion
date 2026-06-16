---
description: Triage open Dependabot PRs, return a quick risk/action summary table, then enter planning mode with an ordered rebase→merge→follow-up→resume resolution plan.
allowed-tools: Bash(gh pr list *), Bash(gh pr view *), Bash(gh pr diff *), Bash(gh pr checks *), Bash(git *), Read, Grep, Glob
---

You are running the `/resolve-dependabot-prs` command. Your job is a **two-phase** workflow:

1. **Analyze (read-only)** — enumerate the repo's open Dependabot PRs, assess each (scope, bump, CI, risk), decide a merge/close order, and emit a terse summary table to the user.
2. **Plan (enter planning mode)** — write a resolution plan whose steps ARE the executable sequence (rebase → merge → optional follow-up PR → resume the chain → close-for-High), ordered per the analysis. The user reviews and approves the plan through the normal plan-approval flow; the agent executes it afterward.

The user drives the loop and approves the plan. This command does not merge, rebase, close, comment, commit, or push anything. It analyzes, summarizes, and produces a reviewable plan.

**Hard rules.**

- During the analysis pass and during planning: **no merge, no rebase, no `gh pr comment`, no commit, no push, no source edits.** Analysis is read-only; planning only writes the plan file.
- User-facing output is intentionally terse: a single "Running the Dependabot PR analysis…" notice, then the summary table, then the short special-case blurb. **No lecture. No per-PR prose for trivial bumps.** The plan artifact carries all execution detail.
- The actual rebase / merge / close / follow-up steps are written **into the plan**, not performed by this command. They execute only after the user approves the plan.
- If there are zero open Dependabot PRs, report "No open Dependabot PRs." and stop — **do not** enter planning mode.

---

## Step 0: Announce

Emit exactly one short line to the user before doing the work:

> Running the Dependabot PR analysis…

Do not narrate each command as you run it. The next thing the user should see is the summary table.

---

## Step 1: Enumerate open Dependabot PRs

```bash
gh pr list --author "app/dependabot" --state open --json number,title,headRefName,labels,createdAt,url
```

Belt-and-suspenders: the Dependabot author handle can differ across repos. Also enumerate by the `dependencies` label and union the results:

```bash
gh pr list --label dependencies --state open --json number,title,headRefName,labels,createdAt,url
```

Deduplicate by PR number. If the union is empty, stop:

> No open Dependabot PRs.

Do not enter planning mode in that case.

---

## Step 2: Gather per-PR signal (read-only)

For each open Dependabot PR `{n}`, collect:

- **CI status** — green / failing / pending:
  ```bash
  gh pr checks {n}
  ```
- **Changed files → scope** — which directories the PR touches:
  ```bash
  gh pr diff {n} --name-only
  ```
  Map the touched directories to a scope using the Dependabot config (`.github/dependabot.yml`) and the root `AGENTS.md` commit-scope table:

  | Touched path | Ecosystem (from dependabot.yml) | Scope |
  |--------------|----------------------------------|-------|
  | `engine/` (`go.mod`/`go.sum` or `Dockerfile`) | gomod / docker | `engine` |
  | `relay/` (`go.mod`/`go.sum` or `Dockerfile`) | gomod / docker | `relay` |
  | `desktop/` (`package.json`/`package-lock.json`) | npm (dev-deps / prod-deps) | `desktop` |
  | root `package.json` / `package-lock.json` | npm (`all-npm-deps`) | `repo` |
  | `.github/workflows/` | github-actions (`all-actions`) | `repo` |

- **Bump type** — parse the PR title for ecosystem + version change (patch / minor / major) and whether it's a grouped update (titles like "Bump the all-go-deps group" / "Bump the prod-deps group").
- **Mergeability / conflict state**:
  ```bash
  gh pr view {n} --json mergeable,mergeStateStatus
  ```
- **Known-issue flag** — determine whether the bump is expected to require a follow-up code correction (a dependency whose changelog/migration notes indicate breaking behavior that the repo's code must adapt to). If so, flag it; this drives the follow-up-PR step in the plan.

---

## Step 3: Classify risk (simple, three-tier)

Keep it simple. Assign each PR exactly one tier:

- **Low** — lockfile-only / patch bumps / desktop `dev-deps` / `github-actions` / `docker` base-image bumps, with **CI green**.
- **Medium** — minor bumps to production/runtime deps (engine gomod, relay gomod, desktop `prod-deps`, root npm) with **CI green**, OR any bump that needs a known follow-up correction.
- **High / close** — CI failing, conflicts that won't resolve cleanly, a major version bump that slipped through, or a dependency with breaking changes that needs focused, separate work. Recommend **close** (not merge), with a one-line reason.

---

## Step 4: Determine the resolution order

Decide the rebase → merge → resume order:

- Merge the **lowest-risk, smallest-surface, CI-green** PRs first (`github-actions`, `docker`, desktop `dev-deps`, patch `gomod`).
- Group by ecosystem so lockfile churn collides minimally. When two PRs touch the **same lockfile** (`package-lock.json` at root, `engine/go.sum`, `relay/go.sum`, `desktop/package-lock.json`), they cannot both merge cleanly without a rebase **between** them — note this; the plan must sequence a rebase between same-lockfile PRs.
- For any **known-issue** PR, schedule its follow-up immediately after its merge: a new branch, the correction commit, a follow-up PR opened and merged, before resuming the Dependabot chain.
- For **High** PRs, the resolution is **close** (`gh pr close` with the reason), not merge.

State the order explicitly so the plan steps follow it top-to-bottom.

---

## Step 5: Emit the user-facing summary (terse)

Output one markdown table with these columns:

| PR | Scope | Bump | CI | Risk | Action |
|----|-------|------|----|----|--------|

- **PR** — `#{n} {short title}`
- **Scope** — `engine` / `relay` / `desktop` / `repo`
- **Bump** — `patch` / `minor` / `major`
- **CI** — ✅ green / ❌ failing / ⏳ pending
- **Risk** — Low / Medium / High
- **Action** — `merge` / `rebase first` / `follow-up` / `close`

Below the table, add bullets **only** for PRs that need more than "merge it":

- a required **follow-up PR** (what the correction is, in one line),
- a **close** recommendation (too risky / needs focused work — one-line reason),
- a **same-lockfile ordering** caveat (which PRs collide and need a rebase between them),
- **failing CI** (what's red).

Trivial "merge it" PRs get **no** bullet. Do not include a suggested-order paragraph here — the order lives in the plan. This table plus the special-case bullets, preceded only by the Step 0 notice, is the entire user-facing message.

---

## Step 6: Enter planning mode and write the resolution plan

After emitting the summary, **enter planning mode**. A plan artifact is created automatically and the user reviews/approves it through the normal flow — do not re-encode that mechanism, just enter planning mode and author the plan.

The plan's steps ARE the executable resolution sequence, in the order decided in Step 4. For each PR (or grouped batch), lay out the concrete steps:

1. **Rebase** the Dependabot PR — either by posting `@dependabot rebase` (the user does this, or it is the first executable step) or, where appropriate, a local rebase of the dependabot branch onto updated `main` + force-push. Choose per the PR's conflict state from Step 2.
2. **Merge** that PR:
   ```bash
   gh pr merge {n} --merge
   ```
3. **If** the PR was flagged known-issue: create a branch off updated `main`, commit the correction (conventional commit, correct scope, per root `AGENTS.md` "Commits"), open the follow-up PR, wait for CI, then merge it.
4. **Resume** the chain with the next PR — re-rebase the remaining Dependabot PRs onto the updated `main` as needed before each merge (this is where same-lockfile collisions from Step 4 are resolved).
5. For **High** PRs: close instead of merging —
   ```bash
   gh pr close {n}
   ```
   with the recorded one-line reason.

The plan must reference the relevant **quality gates** from the root `AGENTS.md` gate table that each merged scope needs to pass before its merge, e.g.:

- engine `gomod` bump → `cd engine && go test -race ./...`, `govulncheck ./...`, `golangci-lint run`
- relay `gomod` bump → `cd relay && go test -race ./...`
- desktop `npm` bump → `cd desktop && npm run typecheck`, `npm test`, `npm audit --audit-level=high --omit=dev`
- root `npm` / `github-actions` / `docker` → the corresponding gate(s) for the touched surface

The plan is built **per the analysis recommendations** — order, follow-ups, and closes all flow from Steps 3–4. After entering planning mode and authoring the plan, stop. Execution happens only after the user approves the plan.
