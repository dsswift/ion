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
Nothing is merged *into* an existing bench incrementally. Every assembly throws
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

### Members are pinned; assembly never advances a pin

Each member records the exact contribution currently integrated
(`pinnedSha`, `pinnedTreeHash`). Assembly merges the **pins**, never a fresh read
of a member's current tip. Pins advance only by an explicit act: enrollment, or
*Update* on that member.

This is what makes manual integration real. Members A and B are both stale; A is
ready, B is one commit into a two-commit change. Update A and reassemble: A's work
lands in the bench, and **B stays at its previously pinned commit**. Without
pinning, an assembly triggered for A would drag in B's half-finished pair, and
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
unattended assemblies safe; with the operator holding the only trigger, each is
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

A member's pin is `behind` when its contributed **tree hash** differs from its
pinned tree hash. Sha comparison lies in both directions: an amend or reword yields a
new sha with an identical tree (a false stale, offering an Update that changes
nothing), and a rebase changes content with no new commit (a missed stale).

Staleness may be automatic *precisely because it is advisory*. It paints a badge
and never merges, assembles, or advances a pin, so a late or briefly-wrong badge
costs nothing. That is what makes riding the existing debounced `GitRepository`
watcher acceptable here and unacceptable as an assembly trigger.

### Member state is three orthogonal axes, not one enum

A member's state was a single `MemberStatus` union mixing three independent
questions: is it enrolled (`excluded`), how fresh is its pin (`pending`,
`integrated`, `stale`, `landed`), and what did the last merge do (`conflicted`,
`missing`). A member can be all three at once, and one enum can report one.

This was not a theoretical concern. The staleness evaluator carried a priority
ladder whose own comment admitted the collision — *"never overwrite a conflict
verdict with a staleness verdict"* — and the ordering meant an excluded member
that had also moved on reported only `excluded`. Re-enabling it merged a stale
pin with no warning on any surface, because the freshness fact had been
destroyed at write time and no renderer could recover it.

So the state is three fields with three owners:

| Axis | Field | Owned by |
|---|---|---|
| Enrollment | `enabled` | the operator |
| Pin freshness | `pin` (`empty`/`current`/`behind`/`absorbed`/`gone`) | staleness evaluation |
| Merge outcome | `merge` (`unbuilt`/`merged`/`conflicted`/`skipped`) | assembly |

No evaluation can clobber a fact it has nothing to say about, so the ladder is
gone rather than reordered. Clients summarise the axes into one indicator when
space is scarce, but the summary is a rendering choice made against complete
data — not a lossy write.

Persisted records migrate on read: the pins are operator intent, so resetting
would silently re-pin everyone at their current tip. For `excluded` and
`conflicted`, which carried no freshness information at all, the pin is
recomputed from the tree hashes, recovering exactly what the old ladder threw
away.

### Membership is a sidecar, keyed by worktree path

A member record used to re-declare `worktreePath`, `branchName`, and `label`,
and it still needed `title`, which it did not have — so the wire layer resolved
the title by joining against the inventory and documented the join as a
workaround. The join was already the truth; it was performed late, once, in one
projection no other consumer could reach.

A member is therefore **a pin plus a verdict, keyed by worktree path**, holding
no worktree fields at all. `shared/worktree-list.ts` performs the join for every
surface, so the desktop list, the ATV mirror, and the iOS projection cannot
disagree about what a worktree is or where it sorts.

Merge order stays **array position**. Assembly iterates the member array, so an
explicit `order` field would be a second source of truth able to disagree with
the order the merge actually walks; the displayed sequence number is derived at
join time and never stored.

One consequence is visible in the UI: a worktree appears exactly once. The panel
previously listed enrolled worktrees twice — once as a worktree, once as a bench
member — in two components with two vocabularies for the same facts.

### The two verdicts have different lifetimes

The operator can mark a member `good` or `issue`, and the two make different
statements. `good` says "I reviewed the feature and it works" — a statement
about the **feature** that stays true across assemblies, syncs, and pin
advances, so once earned it is only ever changed by the operator. `issue` says
"this contribution has a bug that future changes must fix" — a statement about
the **pinned contribution**, so advancing the pin clears it: the new content is
a clean slate for retesting, and the operator re-flags it if the bug survived
or marks it good once the fix lands. Re-pinning identical content (an Update
that finds nothing new) keeps either verdict, because the reviewed thing has
not changed.

Absent means unreviewed, which is deliberately distinct from reviewed-and-fine —
a three-valued flag defaulting to neutral would make "nobody has looked at this"
indistinguishable from "someone looked and it was fine".

### Landing is absorption, not removal

When a member's work lands into the feature branch it becomes part of the
bench's **base**, permanently and without option. The bench reassembles from the
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

### A contribution is a range, so "not started" is not "landed"

All three landed tiers above answer *yes* for a member that has committed
**nothing**. A worktree cut from the feature branch and enrolled before its first
commit has a HEAD identical to the feature-branch tip, so the pinned commit is an
ancestor of the source branch, the pinned tree is in its history, and the branch
does not differ from it. The bench read that as landed and retired the member on
every assembly — a worktree could not stay enrolled before its first commit, which
is precisely when an operator wants to enroll it.

No query at assembly time can separate the two cases, because after the fact they
are identical: in both, `sourceBranch..pinnedSha` is empty. The separating fact is
where the contribution **starts**, so a pin records it: `pinnedBaseSha` is the
merge base of `pinnedSha` and the source branch, captured when the pin is taken.
A contribution is therefore the range `pinnedBaseSha..pinnedSha`, and an equal
pair means empty — a fact that survives the source branch moving underneath it.

An empty contribution is reported `pending`: kept in the member list, merged into
nothing, never retired. It is not terminal and not an error. The member becomes
`stale` the moment the worktree commits, and Update pins the real work. Absorption
now applies only to a pin that carried commits in the first place.

Records written before the range was tracked carry `pinnedBaseSha: ""`, which
means **unknown**, never empty. Assembly resolves it once against the member branch
and backfills it: a branch with commits beyond the source branch behaves exactly
as before, a branch with none is `pending`, and a branch that no longer exists
(the normal *Land & retire* outcome) stays unknown and falls through to the tiers
above, which correctly retire it.

### A pin reads the branch ref, never HEAD

A member's identity is its **branch**, not whatever its worktree has checked
out. The two differ exactly when it matters most: a conflicted rebase (the sync
verb's failure mode) leaves the worktree in detached HEAD at the rebase's
transient position, while the branch ref still points at the member's real tip —
git only moves the branch when the operation completes. An earlier
`captureContribution` read HEAD, so a member stranded mid-rebase was pinned at
the source tip with an empty range and reported `no commits yet` for a branch
holding real commits. Both `captureContribution` and `contributedTreeHash` now
resolve `member.branchName`, which is correct at every moment with no
mid-operation mode split.

### A conflicted sync is surfaced and resolvable, never silent

The sync verb rebases the worktree onto its source branch, and a real conflict
stops that rebase halfway: HEAD detaches, the worktree drops out of every
appraisal, and — before this was fixed — the failure went to the log file only
while the panel showed nothing. The operator believed the sync succeeded.

Three surfaces now carry the state, all fed by the same probe
(`main/git/operation-state.ts`, which resolves rebase/merge/cherry-pick state
via `rev-parse --git-path` so linked worktrees are read correctly):

- the inventory keeps a mid-operation worktree visible, with `operationState`
  and its conflicted paths (the branch is recovered from
  `rebase-merge/head-name` while HEAD is detached);
- a toast fires at the moment a sync or land fails with conflicts, and the
  worktree row shows `conflict · Resolve`; dismissing the toast never hides the
  row badge, which derives from live repository state;
- the ConflictsDialog lists each conflicted file with its shape (both
  modified, both added, delete/modify) and resolves it by Accept Yours, Accept
  Theirs, or a 3-way merge editor (`merge-model.ts` implements the diff3
  alignment; one-sided changes auto-apply, only contested chunks demand a
  decision). Ours/theirs are always labelled with branch names, because a
  rebase inverts git's sides and bare "ours" mid-rebase means the branch being
  rebased ONTO — precisely the confusion a resolution UI must remove.

The dialog's AI Assisted button opens a FRESH conversation in the conflicted
directory (never an existing one — a live thread would be interrupted and its
context could sway the fix) and submits the fixed prompt naming the operation
actually in progress (`Please fix my currently in-progress rebase.` for a sync,
`…merge.` for a bench resolution) — one forwarded store action, per the ATV
multi-step rule. The assist requires the `standard` tier in
`~/.ion/models.json` and refuses with a remediation message when it is absent
(resolved through the engine's `resolve_model_tier` command; the engine owns
the file's semantics). The fresh conversation is pinned to that tier's model
and forced into auto mode regardless of the operator's default — a plan-mode
default would park the fix writing a plan. Abort and Continue drive the
underlying operation (probed live, so a merge gets `git merge --continue`, not
a rebase verb that would fail); Continue enables only when nothing is left
unmerged. Resolution is desktop-only; iOS renders `operationState` and a
conflicted-file count so a mid-rebase worktree neither vanishes nor looks
healthy on the phone.

### Assembly is atomic: the whole combination or nothing

A member whose pinned contribution will not merge fails the **entire**
assembly. The failed merge is aborted, the conflict is recorded on the member
(`conflictPaths`, plus `conflictsWith` attributed by diffing each prior
member's **contribution range** — never its tip commit, which misses any
collision introduced by an earlier commit in the range), and the bench branch
is pointed at an empty-tree commit. Tracked files vanish; ignored build output
survives, exactly as across a normal assembly. The workspace records
`lastAssembly: 'failed'` and an operator-facing `lastAssemblyError`, which the
bench bar (desktop) and bench header/footer (iOS) render in place of the age
line.

Rejected: skip the conflicted member and keep the rest (the original
behaviour). It produced a silent partial bench — the operator tested a
combination that misrepresented what was enrolled, and nothing said so. The
members merged before the conflict even reported `merged` while their content
sat in a tree that no longer existed. Partial-on-purpose remains available
through the per-member exclude toggle, which is an *explicit* subset rather
than an accidental one; every non-conflicted enabled member reports `unbuilt`
after a failed assembly, because claiming anything else would describe a wiped
tree.

### A bench conflict is resolved once, then replayed (`git rerere`)

A bench conflict differs from a conflicted sync in one structural way: the
bench is ephemeral, so a resolution committed *in* the bench is destroyed by
the next assembly, and the operator would re-resolve the same collision
forever. The answer is git's own answer for its `seen` integration branch —
**rerere** (reuse recorded resolution):

- Assembly enables `rerere.enabled` + `rerere.autoUpdate` repo-locally (shared
  through the common dir with every worktree, so the operator's own manual
  rebases benefit too).
- The **resolve-once flow** (`prepareConflictResolution`) re-runs the assembly
  sequence and leaves the conflicted merge **in progress** in the bench. The
  ConflictsDialog then operates on a real merge with real index stages —
  Accept Yours/Theirs, the 3-way editor, and AI Assisted all work unchanged.
  Completing the merge is what records the resolution, keyed by the conflict's
  text, in the **main repo's** `rr-cache` — wiping the bench cannot lose it,
  and unrelated repo activity cannot invalidate it.
- Every later assembly hits the same conflict, replays the recording, commits
  the merge, and reports the member `merged` with `mergeResolution:
  'replayed'` — observable on the record, the wire, and the logs, because a
  replayed resolution is deterministic but is **not** the same fact as a clean
  merge.
- When either side's conflicting lines genuinely change, the recording stops
  matching and the assembly honestly fails again: one fresh resolution per
  genuinely new conflict, the theoretical minimum.

While the machinery-prepared merge is open, both enforcement halves carve out
exactly the resolution surface and nothing else. The desktop guard passes the
conflict-resolution IPC and merge abort. Engine workspace containment passes
`Write`/`Edit` on **unmerged paths only** because an edit to a conflicted path
during resolution is the reviewable artifact that becomes the recording. Merge
completion has a stricter invariant: `git merge --continue` must be a standalone
call in the model response, the index must contain no unmerged entries, and
`git diff --cached --check` must accept the staged resolution. This prevents a
failed edit, formatter, test, or staging command from being masked by a later
Continue in the same shell or parallel tool batch.

Automatic rerere replay obeys the same staged-content validation before the
machinery commits it. An invalid replay is never treated as "nothing left to
resolve": Ion captures the exact rerere paths while the conflict context exists,
forgets the bad recording, and recreates the same real merge for fresh
resolution. If capture or forget fails, the flow stops visibly rather than
claiming recovery. Desktop Continue also runs its preflight, mutation, and
postcondition checks under the repository mutation queue; success requires that
the operation ended, HEAD advanced, and the resulting delta passes
`git diff --check`. A bad resulting commit is rolled back and the original
conflict is recreated. Both carve-outs fail closed: an unreadable probe refuses
as before, the conservative direction for a permission widening.

### Text checks accept broken trees; the project's verify command decides

`git diff --cached --check` and the unmerged-path probe are **text** checks: a
resolution can pass both and still not compile (the live case: a recorded
resolution carrying a duplicated `}, "")` line that git considered clean). A
resolution is only correct when the project accepts the resulting tree, and Ion
must not know Go from npm — so the project declares the check in the committed
`.ion/worktree.json` as `bench.verify` (see
[worktree-json.md](../../configuration/worktree-json.md) § "Bench verification").

Two gates, one command:

- **Record time.** Desktop Continue runs `verify` after its postconditions
  pass. On failure the merge is rolled back through the existing
  `restoreConflict` path — reset, recreate, forget the just-written recording,
  re-verify fresh unmerged paths. Poison is never recorded.
- **Replay time.** An assembly that replayed at least one recording runs
  `verify` after the member loop. On failure the replayed recordings are
  forgotten, the bench is wiped to the atomic-failure state, and the assembly
  reports failed naming replay poison. Clean-merge-only assemblies skip the
  gate: they contain exactly what the members committed, so a build failure
  there is member breakage, not Ion-introduced state — and a bench exists to
  build in-flight combinations that may legitimately not compile.

### Recorded resolutions can be purged

Prevention stops new poison; it cannot reach a recording already written, nor
recordings the operator's own manual rebases produced outside Ion. Two verbs,
both desktop-only (destroying resolution history is a deliberate desk action —
the same posture as Retire):

- **Forget resolutions for these files** — the targeted verb and the default.
  Given the conflicting paths on the membership record, forget only the
  recordings covering them. Costs one re-resolution, keeps the rest.
- **Discard all recorded resolutions** — the blunt verb, behind a confirmation
  naming the exact count of recordings that will be lost, because that count
  is the entire decision. Every conflict ever resolved comes back.

The cache path is always derived via `git rev-parse --git-common-dir` — never
assembled by hand — and the deletion refuses any resolved path whose basename
is not `rr-cache`.

The badge on a conflicted member opens the **BenchConflictDialog**, which reads
the membership record (no operation probe — after the atomic wipe there is
nothing in progress on disk) and offers the two exits: *Resolve once* (the flow
above) and *open the member worktree* (the durable fix: rework the collision
where it can be committed, then Update and reassemble). Routing this badge to
the operation-state ConflictsDialog was the original defect: it probed a clean
bench, listed no files, and disabled its own Abort.

### Pin updates warn about the collision before it costs a bench

`Update` and `Update all` dry-run the new pin against a simulation of the next
assembly (`git merge-tree --write-tree` — in memory, no checkout) and attach a
non-blocking warning naming the files when it will conflict. **Warn, never
gate**: overlapping in-flight work is the bench's most valuable case, conflicts
are not knowable at enrollment time anyway, and the operator decides whether to
resolve now or keep working. The warning rides the op result to every client.

### Retirement is surfaced, never silent

A retired member's row disappears. A row vanishing with no explanation is
indistinguishable from the bench losing a worktree, which is how the `pending`
defect above was first reported. `BenchAssembleResult.retired` carries the absorbed
members and the git panel names them ("… landed into `<branch>` and is now part of
the base") until the operator dismisses the notice. Dismissal is per-window UI
state: it mutates no bench record, which is why it is mirror-local rather than
forwarded.

### Never `git clean -x`

`switch -C ... --discard-changes` resets tracked files and **leaves ignored
build output in place** (`node_modules`, `dist`, Go caches). That single
decision is what makes an assembly cost an incremental build instead of a cold
one, and it is the reason the feature is usable at all.

### The bench refuses history writes

Git commands that write **history** are refused inside a bench: `commit`, `push`,
`pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `stash`, `tag`, and
branch mutation (`branch`, `checkout`, `switch`). A commit made there is
destroyed by the next assembly, and a push would publish a synthetic merge of
other people's in-flight work.

The refusal has two independent halves, because there are two actors:

| Actor | Enforcement | Where |
|---|---|---|
| Agent (tool call) | Engine-core workspace containment, checked in the tool loop beside the permission engine | `engine/internal/workspaces` |
| Operator (git panel button) | Early-return refusal in the git IPC handlers | `desktop/src/main/integration/bench-guard.ts` |

The agent half is engine core, not an extension: containment is pure mechanism
(deterministic path rules over two JSON records plus git state), every
consumer that uses benches needs it, and a tool call must be refusable
regardless of which extensions are loaded. It is on by default and disabled
only by an explicit `security.workspaceContainment: false`; the `tool_call`
hook still fires before execution, so a harness can layer STRICTER policy but
cannot loosen the baseline. The two halves cannot share code — Go and
TypeScript on opposite sides of the socket — so the path-containment rule is
stated in both places, and each carries a test pinning identical behaviour
(root match, subdirectory match, sibling-prefix rejection).

Both **fail open** when the workspace record is missing or corrupt. A false
refusal would block legitimate commits in an ordinary worktree, which is worse
than briefly missing the guard; and because the two halves are independent, a
read failure in one does not leave the bench unguarded against the other.

Reading, building, and testing are unaffected — they are the point. So are
`add`, `restore`, `clean`, and `apply`: they touch the index and working tree
rather than history, `--discard-changes` already resets them on the next
assembly, and `apply` in particular is how hunk-level staging works, so refusing
it would break diff review in the one place the bench exists to serve.
Over-blocking here is as much a defect as under-blocking.

### The bench refuses edits, and names where they belong

The history rule above governs `commit`, `push`, and their kin. It says nothing
about `Write` and `Edit` — and the agent-side gate only ever inspected `Bash`, so
an agent in a bench conversation could edit bench files freely. The edit
succeeded, looked successful, and was destroyed by the next
`switch -C … --discard-changes`. Same invisible work-loss the history rule
prevents, left open on the other axis.

The engine's workspace containment closes it: a write-class tool call
(`Write`, `Edit`, `NotebookEdit`) whose target is inside a bench is refused —
judged by the TARGET, so a conversation running elsewhere that writes into a
bench is refused too. `Bash` file-writes are deliberately not inferred —
gating Bash on cwd would refuse the builds and tests the bench exists to run;
its git invocations are covered by the history rule above.

The desktop half is the panel itself: in a bench the git panel hides Changes and
Graph entirely and titles the section `Integration (Bench)`
(`desktop/src/renderer/components/git/benchContext.ts`). A Changes section in a
bench is an invitation to lose work, and bench history is synthetic — one merge
per member, recreated each assembly.

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

### The refusal message is the teaching surface

The containment is reactive: it refuses a wrong write when the model attempts
it. The refusal message therefore carries everything the model needs to
redirect rather than retry — the offending path, what that path belongs to,
the owning member(s) with changed line ranges for a bench write, and the
worktree or member checkout where the work belongs. A harness that wants
proactive teaching (a bench briefing in the system prompt, bench-introspection
tools) can build it on existing SDK surface (`before_prompt` injection, tool
registration); the engine baseline does not depend on one being loaded.

### A worktree refuses writes outside itself

The bench rule above has a sibling that applies to ordinary worktrees. A worktree
exists to isolate one conversation's work onto its own branch, so a write from a
worktree conversation into the **base repo it was cut from**, or into a **sibling
worktree of the same repo**, is refused by the same engine-core workspace
containment, at the same tool-loop seam.

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
command. So the containment splits the command on `&&`, `||`, `;`, `|`, and
newlines (respecting quotes, so a `&&` inside a commit message is not a
separator) and resolves every destination-changing construct it can read as a
**literal** path: `cd`, `pushd`, `git -C`, `--work-tree`. `cd` is applied
sequentially, because everything after it runs in the new directory. Each
resolved destination is then checked by the same policy as any other target.

A destination is only ever resolved when it is literal. `cd "$TARGET"`,
`cd $(git rev-parse --show-toplevel)`, and a path built inside an invoked script
are **not** resolved: the call passes and the construct is logged at WARN
(tag `workspaces`, "bash destination unresolved") so the residual gap is
queryable rather than invisible. That asymmetry is the design — a refusal
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
  is one click, which *Update all & assemble* collapses for the common case.
- One bench per `(repo, source branch)`, each with its own build tree and its
  own cold first build. Bench count is uncapped.
- Bench edits are transient by design. The member set and its pins are the only
  durable artifacts; deleting the state file loses the member set, never code.
- Conversation relocation is composed from existing primitives
  (`restartTabEntry` + `ensureSession`) rather than a new engine API — the
  correct layer, since no engine contract needed to change.
