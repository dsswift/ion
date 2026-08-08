# Worktree/bench failure modes — confirmed reproductions and their tests

This is a living catalogue of git-mechanics failure modes in the worktree/bench
subsystem, seeded from a single investigation (see the incidents below) and
meant to grow every time a new one is confirmed. Each entry states the git
mechanism, an exact real-git reproduction, the fix location, and the test that
pins it — so "does this actually work, not just in theory" is answerable by
reading this file, not by re-deriving it from logs.

**Discipline for every future entry:** real git via `execFileSync`, never a
mock (the behavior under test is git's own — rerere, abort semantics, merge
refusals — and a mock would just restate the assumption being tested). Every
test must be written to fail on the unfixed code and pass on the fixed code;
confirm this by reverting the fix and watching the test go red before
shipping.

## 1. Untracked leftover survives `merge --abort`, blocks every later merge at that path (bench)

**Mechanism.** `git merge --abort` reverts tracked index/working-tree state
but does not delete an untracked, non-ignored file already on disk before the
merge started — even when that file sits at a path the incoming branch also
wants to write. `git switch -C ... --discard-changes` (the bench's
reset-to-tree step) resets tracked files only, by design, so the leftover
survives every subsequent reset too.

**Reproduction.** Confirmed directly: create an untracked file at a path a
branch's committed content also occupies, attempt the merge (git refuses with
`error: The following untracked working tree files would be overwritten by
merge: ...`), abort, and observe the file is still present and still
untracked.

**Fix.** `resetBenchToTree` (`desktop/src/main/integration/bench-assemble-support.ts`)
runs `git clean -fd` (never `-x`, so ignored build output survives)
immediately after every reset-to-tree. Applied at all six bench call sites
that reset or recreate a merge: `bench-assemble.ts`, `wipeBenchToEmpty`,
`bench-recording-recovery.ts`, `bench-resolve.ts`,
`bench-verification-diagnostic.ts`, and the internal abort-and-recreate cycle
in `bench-assembly-rerere.ts`.

**Test.** `desktop/src/main/__tests__/bench-assemble-untracked.test.ts` →
`assembleBench — untracked leftovers self-heal on the next reset`.

## 2. A merge failure with zero unmerged paths is misclassified as a content conflict, and the real git error is discarded (bench)

**Mechanism.** A genuine content conflict always produces at least one
unmerged index entry (`git diff --diff-filter=U`). A merge failure that
never reaches conflict state — the untracked-obstruction case above, a
filesystem error, any preflight git refusal — produces zero. The pre-fix code
did not distinguish the two: it classified every failure as `'conflict'` and,
when there were no paths to report, fell back to a bare
`"<branch> could not be merged."` message that discarded the actual git
stderr.

**Fix.** `classifyMergeFailure` (`bench-assemble-support.ts`) branches on
`paths.length`: `> 0` → `'conflict'` (unchanged message shape); `=== 0` →
new `'obstructed'` classification, with the real git error surfaced verbatim.
`lastAssemblyFailure` widened to `'conflict' | 'verification' | 'obstructed'`
across `types-bench.ts`, `protocol-worktree.ts` (desktop↔iOS wire, lockstep),
and `bench-store.ts`'s persistence normalizer.

**Test.** `desktop/src/main/integration/bench-assemble-support.test.ts` →
`classifyMergeFailure` (direct unit tests of the classification decision,
since self-healing means an obstruction can no longer reach the assembly
loop's own merge attempt under normal operation — the classification is
pinned at the seam where it is actually decided).

## 3. Untracked leftover survives `rebase --abort` / mid-rebase, blocks `rebase --continue` at a later step (worktree sync)

**Mechanism.** Identical to #1, confirmed separately for `rebase --abort`:
an untracked file appearing at a path a LATER rebase step wants to write
causes `rebase --continue` to fail with git's own "would be overwritten by
rebase" error — a different failure shape than a real conflict (no unmerged
paths; nothing here is a content collision to resolve).

**Why the fix is NOT a blind clean (unlike #1).** The bench is disposable by
design; a member worktree is the operator's durable working directory and may
legitimately hold untracked scratch content. A blind `clean -fd` there would
be the same heuristic-replacing-a-precise-mechanism anti-pattern this
catalogue exists to prevent. The correct fix parses git's own exact,
authoritative list of blocking paths from its refusal message and removes
only those, after re-verifying each is still untracked immediately before
deletion.

**Fix.** `parseUntrackedObstruction` + `retryAfterClearingBlockingUntracked`
(`desktop/src/main/git/untracked-obstruction.ts`), wired into
`completeRebaseIfReplayed`'s `--continue` and `--skip` calls
(`desktop/src/main/worktree/sync.ts`).

**Tests.**
`desktop/src/main/git/untracked-obstruction.test.ts` (parser + retry helper,
including the precision guarantee that an unrelated untracked file is never
touched) and
`desktop/src/main/__tests__/worktree-sync-mechanics.test.ts` →
`completeRebaseIfReplayed — untracked-obstruction self-heal`.

## 4. Rerere path capture and staged-content validation swept in every staged file, not just the genuinely conflicting one (bench)

**Mechanism.** `git rerere status` (and even the raw `.git/MERGE_RR` record)
go EMPTY once `rerere.autoUpdate` fully auto-stages a replay — confirmed
directly, and exactly matching a real incident's log
(`rerere_status_paths: []`, `unmerged_count: 0`). The pre-fix fallback for
that case was `git diff --cached --name-only` with no pathspec, which lists
every staged file in the whole merge. When the conflicting member's own
branch is large (tens of commits, hundreds of files) and only one file
actually collided, every other — clean, uninvolved — file the member
committed got swept into the candidate set: a 216-line
"checked invalid rerere recording" log storm (one wasted no-op `rerere forget`
per unrelated file) in the confirmed incident, and a false-positive risk for
the whitespace/conflict-marker staged-content check (an unrelated clean file
with legitimate trailing whitespace or marker-shaped text can fail a check
that has nothing to do with the actual conflict).

**Why scoping to "the incoming commit's own range" does NOT work.** A first
attempt at this fix scoped to `merge-base(HEAD, MERGE_HEAD)..MERGE_HEAD` (the
incoming side's full contribution). Verified directly and found insufficient:
that range still includes every clean file the same large commit introduced,
so it doesn't narrow anything for the case that matters. The correct,
verified bound is the INTERSECTION of "paths HEAD changed since the merge
base" and "paths MERGE_HEAD changed since the merge base" — a path can only
be a genuine collision if BOTH sides independently diverged from their common
ancestor there; a clean two-way add or edit is, by definition, a change on
exactly one side.

**Fix.** `bothSidesChangedPaths`
(`desktop/src/main/integration/bench-resolution-validation.ts`), used to scope
both `currentRererePaths`'s staged-path fallback and
`validateBenchResolution`'s `diff --cached --check`. Falls back to the
unscoped behavior when there is no `MERGE_HEAD` to compute the intersection
against, or when the computation itself fails — matching prior behavior
exactly rather than silently capturing nothing.

**Test.** `desktop/src/main/__tests__/bench-assemble-untracked.test.ts` →
`bench rerere path capture — scoped to paths both sides changed` (both the
capture-scoping and the staged-content-check-scoping properties, each
reproduced with a large-ish member commit containing one genuine conflict
alongside several clean files, matching the confirmed production shape).

## 5. Existing incidents already pinned (pre-dating this catalogue)

Documented in `desktop/src/main/__tests__/worktree-sync-mechanics.test.ts`'s
own header comment and test descriptions — recorded here for completeness,
not re-described:

- **The `josh`-branch-rebase cascade**: rebasing a feature branch onto `main`
  rewrites its history; every worktree cut from the old tip goes base-stale
  at once, and a plain `git rebase <sourceBranch>` (deriving its range from
  the merge base, which now sits behind the rewrite) replays stale copies of
  upstream commits, manufacturing spurious conflicts. Fixed by the
  precise-base rebase (`--onto <source> <storedBase>`) plus
  `patch-identity.ts`'s duplicate-drop.
- **The stale-stored-base incident**: a worktree's rebase completed by
  something other than `syncWorktreeFromSource`'s own success path (an AI
  assist's raw `git rebase --continue`, or the operator finishing it by
  hand) leaves the registry naming a stale cut point forever, since an
  append-only source branch keeps the old point an ancestor of HEAD. Fixed
  by `base-repair.ts`'s `repairStaleBase`, which recomputes the TRUE current
  fork point before every sync rather than merely validating the stored one.

## Adding a new entry

When a new worktree/bench git-mechanics bug is confirmed:

1. Reproduce it against real git (`execFileSync`, not a mock) until the
   exact failure shape is nailed down — do not guess at the mechanism from
   reading code alone; verify.
2. Add a numbered entry here: mechanism, reproduction, fix location, test
   location.
3. Add the real-git regression test in the appropriate existing test file
   (or a new sibling file at the natural seam, if the file-size cap would be
   exceeded) — written to fail on the unfixed code and pass on the fixed
   code, confirmed by reverting the fix and watching it go red.
4. This is not a mandate to hunt for new failure modes speculatively — it
   fires when a bug is encountered in the normal course of work, per the
   "good citizen" discipline.
