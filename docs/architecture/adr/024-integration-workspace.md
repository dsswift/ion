---
title: "ADR-024: Integration Workspace"
description: The bench is a pure function of its pinned members; integration is manual, staleness is advisory.
---

# ADR-024: Integration Workspace (the bench)

## Status

Accepted.

## Context

Ion's worktree mode gives each conversation an isolated working directory, so
several agents can build features in parallel without colliding. That isolation
is exactly what makes *testing* hard: a feature can only be exercised alone. To
test two in-flight features together the operator had to land one into the
feature branch, which meant unproven work entering the branch to answer a
question about whether it worked.

"Finish work" made this worse by fusing three operations — merge, destroy the
worktree, close the conversation — so integrating always cost the worktree and
the conversation with it.

An **integration workspace** ("the bench") is a separate worktree that layers
several in-flight worktrees on top of the feature branch, so combinations can be
built and tested without landing anything.

## Decision

### The bench is a pure function, never an accumulator

Bench contents are recomputed from `(feature-branch tip, ordered member list)`.
Nothing is merged *into* an existing bench incrementally. Every rebuild throws
the branch away and recreates it:

```
git switch -C ion/bench/<slug> <sourceBranch> --discard-changes
git merge --no-ff -m "ion-bench: <label> (<branch>@<sha7>)" <pinnedSha>   # per member, in order
```

Consequences that make this cheap to own:

- The bench log is **exactly one merge commit per member**, always. Updating a
  member replaces its merge rather than stacking another.
- Removing a member is subtraction from a set. There is no un-merge logic.
- The result is a deterministic function of its inputs, so it can be asserted
  directly in tests rather than inspected for drift.

Rejected: incremental merge-into-bench. It accumulates commits, requires
un-merge logic, and permits drift that no test can pin.

### Members are pinned; rebuild never advances a pin

Each member records the exact contribution currently integrated
(`pinnedSha`, `pinnedTreeHash`). Rebuild merges the **pins**, never a fresh read
of a member's current tip. Pins advance only by an explicit act: enrollment, or
*Update* on that member.

This is what makes manual integration real. Members A and B are both stale; A is
ready, B is one commit into a two-commit change. Update A and rebuild: A's work
lands in the bench, and **B stays at its previously pinned commit**. Without
pinning, a rebuild triggered for A would drag in B's half-finished pair, and
"manual" would still be all-or-nothing.

### Integration is manual; only staleness is automatic

The bench never changes on its own. A worktree's work is not coherent at every
moment the engine can observe — a change may require a pair of commits to build
— and the engine cannot know where the operator's logical unit ends. So it does
not guess. What it does automatically is **notice** and **report**.

Rejected triggers, each with its failure:

| Trigger | Why it fails |
|---|---|
| File-watcher debounce | An agent pauses longer than any window while reasoning, so mid-work trees get benched. |
| Turn end (`running → idle`) | A coherent *moment*, not a coherent *unit*: it fires between the two commits of a pair. |
| Commit | Over-fires on amend/reword (new sha, identical tree), misses a rebase (new content, no new commit). |

Deliberately **not built**: a Hold toggle, a pending-update queue, deferred
apply, auto-apply-when-clear, and settling heuristics. Each exists only to make
unattended rebuilds safe; with the operator holding the only trigger, each is
dead weight.

### Only committed work integrates

A member contributes the tree of its branch HEAD. Uncommitted changes cannot
reach the bench, and there is no mode that relaxes it.

A bench assembled from a half-saved working tree represents a state that exists
nowhere in history: it cannot be reproduced, reviewed, bisected, or landed, and
a failing build has no commit to point at. Committing is how the operator
declares a unit of work coherent — the judgement the bench needs and the engine
cannot make.

An earlier iteration captured uncommitted work through a throwaway
`GIT_INDEX_FILE`. That machinery was removed rather than disabled, so there is
exactly one definition of a member's content.

### Staleness compares trees, not shas

A member is stale when its contributed **tree hash** differs from its pinned
tree hash. Sha comparison lies in both directions: an amend or reword yields a
new sha with an identical tree (a false stale, offering an Update that changes
nothing), and a rebase changes content with no new commit (a missed stale).

Staleness may be automatic *precisely because it is advisory*. It paints a badge
and never merges, rebuilds, or advances a pin, so a late or briefly-wrong badge
costs nothing. That is what makes riding the existing debounced `GitRepository`
watcher acceptable here and unacceptable as a rebuild trigger.

### Landing is absorption, not removal

When a member's work lands into the feature branch it becomes part of the
bench's **base**, permanently and without option. The bench rebuilds from the
feature-branch tip, so the landed work arrives with the base and needs no merge
commit; git reports "Already up to date". The member record is then retired,
because a member represents *pending* work and this work is no longer pending.

Detection is content-based, in three tiers, because the operator squashes a long
stream of iteration commits before landing:

1. the pinned commit is an ancestor of the source branch (the common case);
2. the pinned **tree** appears anywhere in the source branch's history — this is
   what survives *Land & retire* deleting the branch, without which a
   landed-then-retired member is misreported as `missing` and its work looks
   lost;
3. the member branch no longer differs from the source branch.

A sha-only check missed every squash, rebase, and cherry-pick land and would
have re-merged work already in the base.

Absorption is bookkeeping on the bench's member list. It runs **no git command
against the member worktree**: the branch, its commits, and its working tree are
untouched and remain fully usable.

### Never `git clean -x`

`switch -C ... --discard-changes` resets tracked files and **leaves ignored
build output in place** (`node_modules`, `dist`, Go caches). That single
decision is what makes a rebuild cost an incremental build instead of a cold
one, and it is the reason the feature is usable at all.

### The bench refuses history writes

Git commands that write **history** are refused inside a bench: `commit`, `push`,
`pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `stash`, `tag`, and
branch mutation (`branch`, `checkout`, `switch`). A commit made there is
destroyed by the next rebuild, and a push would publish a synthetic merge of
other people's in-flight work.

The refusal has two independent halves, because there are two actors:

| Actor | Enforcement | Where |
|---|---|---|
| Agent (Bash tool call) | `tool_call` hook returning `{ block, reason }` | `engine/extensions/ion-meta/bench-gate.ts` |
| Operator (git panel button) | Early-return refusal in the git IPC handlers | `desktop/src/main/integration/bench-guard.ts` |

They cannot share code — ion-meta ships as a standalone extension bundle with no
desktop or engine imports — so the path-containment rule is stated in both
places, and each carries a test pinning identical behaviour (root match,
subdirectory match, sibling-prefix rejection).

Both **fail open** when the workspace record is missing or corrupt. A false
refusal would block legitimate commits in an ordinary worktree, which is worse
than briefly missing the guard; and because the two halves are independent, a
read failure in one does not leave the bench unguarded against the other.

Reading, building, and testing are unaffected — they are the point. So are
`add`, `restore`, `clean`, and `apply`: they touch the index and working tree
rather than history, `--discard-changes` already resets them on the next
rebuild, and `apply` in particular is how hunk-level staging works, so refusing
it would break diff review in the one place the bench exists to serve.
Over-blocking here is as much a defect as under-blocking.

### The bench refuses edits, and names where they belong

The history rule above governs `commit`, `push`, and their kin. It says nothing
about `Write` and `Edit` — and the agent-side gate only ever inspected `Bash`, so
an agent in a bench conversation could edit bench files freely. The edit
succeeded, looked successful, and was destroyed by the next
`switch -C … --discard-changes`. Same invisible work-loss the history rule
prevents, left open on the other axis.

`engine/extensions/ion-meta/bench-write-gate.ts` closes it: a write-class tool
call (`Write`, `Edit`, `ion_scaffold`) whose target is inside a bench is refused.
`Bash` is deliberately excluded — gating it on cwd would refuse the builds and
tests the bench exists to run.

The desktop half is the panel itself: in a bench the git panel hides Changes and
Graph entirely and titles the section `Integration (Bench)`
(`desktop/src/renderer/components/git/benchContext.ts`). A Changes section in a
bench is an invitation to lose work, and bench history is synthetic — one merge
per member, recreated each rebuild.

**Attribution is per-member, never "who last touched it."** The obvious answer is
`git log -1 -- <path>`, and it is wrong whenever more than one member touches a
file. Measured against this repository's own bench, `AGENTS.md` was modified by
all four enrolled members, so a single-owner answer would have been confidently
wrong three times out of four — sending the agent to edit a file in a worktree
that does not own the change.

The sound question is asked of every member independently:
`git diff --name-only <baseSha> <member.pinnedSha> -- <path>`. That yields the
true owning *set*. One owner is named outright; several are listed with the line
ranges each changed (`git diff -U0`), so the agent picks by the region it is
actually editing. Reporting a true multi-owner answer is correct; guessing one is
the heuristic-for-mechanism anti-pattern.

Staging, discarding, and patch-applying stay allowed in a bench, unchanged —
they touch the index rather than history, `--discard-changes` already resets
them, and blocking them would stop the operator tidying a bench tree.

### A worktree refuses writes outside itself

The bench rule above has a sibling that applies to ordinary worktrees. A worktree
exists to isolate one conversation's work onto its own branch, so a write from a
worktree conversation into the **base repo it was cut from**, or into a **sibling
worktree of the same repo**, is refused: `engine/extensions/ion-meta/worktree-gate.ts`,
wired into the same `tool_call` hook and checked before the git-gate.

The failure it prevents is not theoretical. Five worktree conversations once ran
with their sessions pointed at the shared base checkout. Each one's `git status`
showed the others' uncommitted files, a `git add -A` swept up work belonging to
another conversation, and one commit shipped ~3,000 lines from an unrelated
conversation. The worktrees stayed clean, the base repo went dirty, and nothing
recorded which conversation authored which hunk — review could not untangle it
afterwards.

The rule is deliberately narrow. It is **not** "confine the agent to its cwd":
writes to `/tmp`, `~/.ion`, an unrelated repo, or anywhere else all pass, because
agents legitimately need them and over-blocking would make worktree
conversations useless for real work. The predicate is only:

> cwd is a registered worktree of repo R ⇒ deny writes into R's main checkout,
> and into R's other registered worktrees.

Sibling worktrees are included because sibling-to-sibling bleed is the same
defect with a different destination, and `~/.ion/worktree-registry.json` already
carries the `worktreePath → repoPath` mapping. When cwd is not a registered
worktree the gate passes everything, so an ordinary repo conversation is
completely unaffected. It fails open on a missing or corrupt registry, for the
same reason the bench guards do.

**A `Bash` call is judged by its command text, not only its cwd.** A single
command can leave the worktree and commit elsewhere, and for a while this is
exactly what happened: a conversation whose cwd was its worktree ran 115 commands
prefixed `cd <base repo> &&` and landed two commits on the base repo's branch,
because the gate resolved a `Bash` call to the session cwd and never read the
command. So `engine/extensions/ion-meta/bash-destination.ts` splits the command on
`&&`, `||`, `;`, `|`, and `&` (respecting quotes, so a `&&` inside a commit
message is not a separator) and resolves every destination-changing construct it
can read as a **literal** path: `cd`, `pushd`, `git -C`, `--git-dir`,
`--work-tree`. `cd` is applied sequentially, because everything after it runs in
the new directory. Each resolved destination is then checked by the same policy as
any other target.

A destination is only ever resolved when it is literal. `cd "$TARGET"`,
`cd $(git rev-parse --show-toplevel)`, and a path built inside an invoked script
are **not** resolved: the call passes and the construct is logged at WARN
(`ion-meta: worktree-gate could not resolve a bash destination`) so the residual
gap is queryable rather than invisible. That asymmetry is the design — a refusal
requires a positively-resolved literal path, which makes a false refusal in the
operator's own worktree structurally impossible. Refusing on unresolved
destinations was rejected: it would block `cd $(...)`, per-directory loops, and
any script that changes directory internally, all legitimate work, while `eval`
and `bash -c` defeat any command-string parser regardless. Closing that remainder
needs process-level containment, which is a different mechanism.

**What this gate does not catch.** Its predicate is "is my cwd a registered
worktree", so it is silent on the failure that motivated it — there the sessions'
cwd *was* the base repo, and the gate correctly concludes "not a worktree
conversation" and passes. The fix for that is on the desktop side: worktree
resolution now runs before the engine session starts
(`tab-slice-worktree-resolve.ts`), every directory change relocates the live
session (`tab-working-directory.ts`), and `submitPrompt` reconciles a divergence
rather than discarding the prompt's path (`engine-control-plane-cwd.ts`). This
gate is the net for the next way a directory drifts, not a substitute for
pointing sessions correctly.

### Enrollment is manual; disenrollment is automatic

The bench is created on **first enrollment**, not on first use of a directory:
`ensureWorkspace` writes a record rather than a worktree, so it is cheap enough
to happen implicitly, and which bench a worktree belongs to is fully determined
by its `(repo, sourceBranch)`. A separate "create a bench" step would commit the
operator to nothing and offer no choice, so it does not exist.

Enrollment stays explicit because it is a judgement: putting a worktree in the
bench asserts that its work should be integrated.

Disenrollment is automatic on **retire**, because it is not a judgement. A
member whose worktree no longer exists can never be updated, rebuilt from, or
landed; leaving it produces a permanent `missing` row the operator can only
clear by hand. When the last member leaves, the bench is pruned — record and
worktree — since an empty bench holds nothing unique and keeping them would
accumulate one dead bench per feature branch ever integrated into.

The hook is retire, **not tab close**. Closing a conversation deliberately
leaves the worktree intact so the operator can return to it, so its membership
remains valid.

### Owner-side state

The workspace record lives in the main process
(`~/.ion/integration-workspaces.json`), keyed by `(repoPath, sourceBranch)`. The
desktop overlay, the ATV mirror, and iOS all render that one projection, so the
pin/staleness vocabulary cannot drift between clients.

The key is also the mechanism that keeps projects separate: two worktrees from
different repos resolve to different workspaces, so cross-project blending is
not possible by construction rather than by a rule anyone enforces.

## Consequences

- The bench converges when the operator says so, not while unattended. The cost
  is one click, which *Update all & rebuild* collapses for the common case.
- One bench per `(repo, source branch)`, each with its own build tree and its
  own cold first build. Bench count is uncapped.
- Bench edits are transient by design. The member set and its pins are the only
  durable artifacts; deleting the state file loses the member set, never code.
- Conversation relocation is composed from existing primitives
  (`restartTabEntry` + `ensureSession`) rather than a new engine API — the
  correct layer, since no engine contract needed to change.
