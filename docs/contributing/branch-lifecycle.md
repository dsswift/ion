---
title: Branch Lifecycle
description: The expected flow from feature work to merged pull request, the commands at each stage, and the automation that runs without being asked.
sidebar_position: 5
---

# Branch Lifecycle

This page describes how work moves from a feature branch to a merged pull request in this repository: which commands run at which stage, who initiates each one, and what happens automatically in the background.

It is written for two audiences. **Operators** use it as a refresher on the expected sequence. **Agents** use it to understand where their responsibility ends and the operator's begins.

## The stages

| Stage | Who initiates | What it does | Pushes? |
|-------|---------------|--------------|---------|
| Feature work | Operator asks; agent implements | Code, tests, docs. Committed at clean scope seams — one commit per scope per feature. | No |
| `/align` | Operator | Reviews the work against Ion's quality gates and architectural principles, then authors a fix plan. In plan mode it audits the plan instead. | No |
| `/squash` | Operator | Rebuilds the branch from a soft reset into one commit per scope per feature. Creates a backup branch first. | No |
| `/create-pr` | Operator | Runs the Linux parity gate, pushes the branch, opens the PR with a description derived from the commits. | Yes — the only command that pushes |

The agent's job ends at the commit. Squashing, PR creation, merge strategy, and CI lane choice belong to the operator — see root `AGENTS.md` § "Operator gitops are not yours to narrate or prescribe". An agent should commit verified work and report what is ready, not narrate or prescribe what the operator does next.

## The sequence runs once, before the PR exists

`/align` → `/squash` → `/create-pr` is a **pre-publication** flow.

`/squash` rewrites local history: it soft-resets to `main` and carves the (already correct) working tree into clean commits moving forward. That is safe precisely because nothing has been pushed yet. It never runs `git push` — it reports that the branch is ready and stops.

## After the PR exists, history is append-only

This is the part that trips people up, so it is worth stating directly.

**CI failed on my PR. Do I re-align and re-squash?** No.

Fix commits land on top as ordinary conventional commits, and you push again. CI re-runs. That is the whole procedure.

**Do not re-run `/squash` on a published branch.** Rebuilding history that has been pushed requires a force-push, which:

- breaks review threads, because the commits they were anchored to no longer exist
- invalidates approvals
- severs the mapping between review comments and the code they describe

A branch that reads "four squashed commits, then two fix commits" is honest history. The fixes happened after review began, and the log should say so. `/align` already encodes this rule for its own PR mode — published history is only ever appended to — and it applies equally to the operator's own flow.

## What runs automatically

Git hooks, managed by husky. They install themselves: root `package.json` has `"prepare": "husky"`, so `npm install` (or `make bootstrap`, which wraps it) points `core.hooksPath` at `.husky/_`.

| Hook | When | What |
|------|------|------|
| `pre-commit` | Every commit | `actionlint` on workflow files, when any are staged |
| `commit-msg` | Every commit | `commitlint` — enforces `type(scope): subject` against the allowed scope list |
| `pre-push` | Every push | File-size cap, dashboards drift audit, and change-scoped lint / build / typecheck / tests. Husky runs hooks with `sh -e`, so `.husky/pre-push` is a dash-safe delegator that execs bash on `scripts/pre-push.sh` — the gate body needs bash, and the shebang is not consulted |
| `post-commit` | Commits touching code | Rebuilds the graphify knowledge graph incrementally (AST-only, detached) |
| `post-checkout` | Branch switches | Same graph rebuild |
| `post-merge` | `git pull` / merge | Graph refresh via `scripts/graphify-rebuild.sh` — a fast-forward moves the branch pointer without a checkout, so `post-checkout` never fires |
| `post-rewrite` | `git rebase` / amend | Same refresh; `post-commit` and `post-checkout` both bail during a rebase, so this is their counterpart |

`pre-push` is the gate that catches most problems locally. Bypass with `git push --no-verify` only when you mean it.

## The graph is a local cache (and optional)

`graphify-out/` holds a knowledge graph of the codebase that agents can query instead of grepping. Two things to know, and the second matters more than the first.

**It is entirely optional.** Graphify is not a project requirement. No build, test, CI job, or quality gate reads the graph. If you do not have graphify installed — or cannot install it in your environment — `make bootstrap` prints a skip notice and completes normally, you get every quality gate, and nothing else about contributing changes. Agents are instructed to fall back to ordinary file search when no graph is present.

**Run `make bootstrap` regardless.** It is the entry point for every contributor, not just graphify users, because it is what activates the git hooks (commitlint on every commit, the pre-push gate suite). Skipping it to avoid graphify would forfeit those gates and gain nothing.

If you *do* use graphify, understanding one thing prevents all confusion: **it is a gitignored build cache and there is nothing for you to do about it, ever.**

- It never appears in `git status`, a diff, or a pull request.
- It needs no commit, no cadence, and no cleanup.
- The rebuild hooks **write files but never stage or commit them** — neither `.husky/post-commit` nor `.husky/post-checkout` runs `git add` or `git commit`. They rewrite `graph.json` and `GRAPH_REPORT.md` in place and exit. (`post-commit` mentions `git commit` in one comment, explaining why the rebuild is detached; it does not invoke it.)
- The rebuild is **detached**, finishing a few seconds after the triggering command returns. The graph is therefore always a moment behind, which is expected and harmless.
- Every rebuild path exits cleanly when graphify is missing, so a contributor without it never sees a hook failure.

Refreshes are automatic across every path that changes history: your own commits (`post-commit`), branch switches (`post-checkout`), and pulls, rebases, and amends (Ion's own `post-merge` / `post-rewrite`, via `scripts/graphify-rebuild.sh`). You should never need to refresh by hand.

The primary checkout owns graph mutation. Provisioned worktrees link its `graph.json` for queries and retain local query stamps; `make graph` refuses in worktrees. `make graph-refresh` only creates or validates the primary graph link for compatibility; it never refreshes there.

| Command | When |
|---|---|
| `make bootstrap` | Once per clone. Builds the graph if graphify is installed. |
| `make graph-refresh` | Force an incremental update, e.g. after a `GRAPHIFY_SKIP_HOOK=1` commit |
| `make graph` | Full rebuild from scratch, to purge nodes left stale by incremental updates |

All of these are offline and need no API key: extraction is local tree-sitter, and community partitioning runs with `--no-label` so nothing calls out.

That last flag is why a freshly bootstrapped graph shows `Community 172` rather than a descriptive name. Partitioning is offline; *naming* the communities calls an LLM backend, so bootstrap skips it by default. Run `graphify label` with a backend configured if you want readable names — it improves query output but is never required to query.

Set `GRAPHIFY_SKIP_HOOK=1` to suppress the rebuild for one command.

The graph is a starting point, not an authority. It tells you where to look; the source file is what you read and cite. See root `AGENTS.md` § "Codebase questions" for how to query it effectively.

## Fresh clone

```bash
git clone <repo> && cd ion
make bootstrap
```

That is the whole setup. `make bootstrap` runs `npm install` (activating the hooks), creates the `CLAUDE.md` symlinks, and builds the knowledge graph if graphify is installed. It is idempotent — re-run it any time.

Graphify is the only optional piece. Without it bootstrap prints a skip notice and completes; you get every quality gate and lose only the graph. Install it with `uv tool install graphifyy` (or `pipx install graphifyy`) and re-run `make bootstrap` if you want it later.
