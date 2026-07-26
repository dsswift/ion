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

Four git hooks, managed by husky. They install themselves: root `package.json` has `"prepare": "husky"`, so `npm install` (or `make bootstrap`, which wraps it) points `core.hooksPath` at `.husky/_`.

| Hook | When | What |
|------|------|------|
| `pre-commit` | Every commit | `actionlint` on workflow files, when any are staged |
| `commit-msg` | Every commit | `commitlint` — enforces `type(scope): subject` against the allowed scope list |
| `pre-push` | Every push | File-size cap, dashboards drift audit, and change-scoped lint / build / typecheck / tests |
| `post-commit` | Commits touching code | Rebuilds the graphify knowledge graph incrementally (AST-only, detached) |
| `post-checkout` | Branch switches | Same graph rebuild |

`pre-push` is the gate that catches most problems locally. Bypass with `git push --no-verify` only when you mean it.

## The graph is a local cache

`graphify-out/` holds a knowledge graph of the codebase that agents query instead of grepping. Understanding one thing about it prevents most confusion: **it is a gitignored local build cache, and there is nothing for you to do about it, ever.**

- It never appears in `git status`, a diff, or a pull request.
- It needs no commit, no cadence, and no cleanup.
- The rebuild hooks **write files but never stage or commit them** — neither `.husky/post-commit` nor `.husky/post-checkout` runs `git add` or `git commit`. They rewrite `graph.json` and `GRAPH_REPORT.md` in place and exit. (`post-commit` mentions `git commit` in one comment, explaining why the rebuild is detached; it does not invoke it.)
- The rebuild is **detached**, finishing a few seconds after the commit that triggered it closes. The graph is therefore always a moment behind the commit that caused it, which is expected and harmless.

`make bootstrap` builds the graph once on a fresh clone. `make graph` rebuilds it deliberately — useful if the graph is lost, or to purge nodes that repeated incremental rebuilds have left stale. Both are offline and need no API key: code extraction is local tree-sitter and community labels are LLM-free.

Set `GRAPHIFY_SKIP_HOOK=1` to suppress the rebuild for one command.

The graph is a starting point, not an authority. It tells you where to look; the source file is what you read and cite. See root `AGENTS.md` § "Codebase questions" for how to query it effectively.

## Fresh clone

```bash
git clone <repo> && cd ion
make bootstrap
```

That is the whole setup. `make bootstrap` runs `npm install` (activating the hooks), creates the `CLAUDE.md` symlinks, and builds the graph. It is idempotent — re-run it any time.
