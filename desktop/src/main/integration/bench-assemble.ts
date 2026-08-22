/**
 * Bench assembly — the deterministic function at the center of the design.
 *
 * ── The bench is a pure function, never an accumulator ──────────────────────
 * Bench contents are always recomputed from `(source tip, ordered member
 * list)`. Nothing is ever merged INTO an existing bench incrementally. Every
 * assembly throws the branch away and recreates it:
 *
 *     git reset --hard <sourceBranch>
 *     git clean -fd
 *     git merge --no-ff -m "ion-bench: <label> (<branch>@<sha7>)" <pinnedSha>   # per member, in order
 *
 * Consequences that make this cheap to own:
 *   - The bench log is EXACTLY one merge commit per member, always. Updating a
 *     member replaces its single merge instead of stacking a new one.
 *   - Removing a member is subtraction from a set — there is no un-merge logic
 *     to write and no drift state to reconcile.
 *   - The result is a deterministic function of its inputs, so it can be
 *     asserted directly in tests.
 *
 * ── Pins, not tips ──────────────────────────────────────────────────────────
 * Each member is merged at its PINNED contribution, never a fresh read of its
 * current tip. That is what makes manual integration real: reassembling to pick
 * up member A cannot drag in member B's half-finished two-commit change. This
 * function NEVER advances a pin — pin advancement is the caller's explicit act
 * (see bench-ops.ts).
 *
 * A contribution is a RANGE (`pinnedBaseSha..pinnedSha`), not a tip. A member
 * whose range is empty has committed nothing of its own and is reported
 * `pending`: kept in the list, merged into nothing, never retired. That case is
 * indistinguishable from a landed member by any live git query, which is why the
 * range is recorded at pin time — see resolveContribution below.
 *
 * ── Never `git clean -x` ────────────────────────────────────────────────────
 * `reset --hard` resets tracked files and LEAVES ignored
 * build output (node_modules, dist, Go caches) in place. That single decision
 * is what makes an assembly cost an incremental build instead of a cold one,
 * and it is the reason the feature is usable at all. `resetBenchToTree`
 * (bench-assemble-support.ts) additionally runs `clean -fd` (never `-x`) to
 * remove untracked, non-ignored leftovers a prior merge/abort can strand at a
 * path the next merge wants to write — ignored build output is untouched
 * either way. The atomic-failure wipe below keeps the same property: it moves
 * the branch to an empty-TREE commit (tracked files only) and cleans the
 * same way.
 *
 * ── Assembly is atomic; conflicts fail the whole thing ──────────────────────
 * A member whose pinned contribution will not merge fails the ENTIRE assembly.
 * The failed merge is aborted, the conflict is captured (paths + which earlier
 * members' ranges touch them), and the bench branch is pointed at an
 * empty-tree commit — so a terminal or conversation opened in the bench finds
 * nothing to falsely test. The earlier behaviour (skip the member, keep the
 * rest) produced a silent partial bench: the operator tested a combination
 * that misrepresented what was enrolled. The member list is the exact assembly
 * set, so a partial bench requires removing members before assembly.
 *
 * ── Resolve once: `git rerere` ──────────────────────────────────────────────
 * Before declaring a merge conflicted, `git rerere` is given the chance to
 * replay a previously recorded resolution. Recordings live in the MAIN repo's
 * `$GIT_COMMON_DIR/rr-cache` (linked worktrees share it), keyed by conflict
 * text — so wiping the bench never loses them, unrelated repo activity never
 * invalidates them, and a genuinely changed hunk stops matching and honestly
 * conflicts again. A merge completed this way is committed and reported
 * `merged` with `mergeResolution: 'replayed'`, never silently equated with a
 * clean merge. The recording is made by the resolve-once flow (bench-ops.ts
 * `resolveBenchConflict` + the ConflictsDialog), which leaves a real merge in
 * progress in the bench for the operator to resolve.
 */
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { benchMergeInProgress } from './bench-guard'
import { unmergedPaths } from '../git/operation-state'
import { resolveContribution, isLandedIntoSource } from './bench-contribution'
import { ensureRerereEnabled, tryReplayResolution } from './bench-assembly-rerere'
import { runBenchVerify } from './bench-verify'
import { resolutionsFor } from './bench-resolution-journal'
import { ensureBenchWorktree, describeConflict, wipeBenchToEmpty, resetBenchToTree, classifyMergeFailure } from './bench-assemble-support'
import type { IntegrationWorkspace, IntegrationMember, BenchAssembleResult } from '../../shared/types'

const TAG = 'bench.assemble'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Assemble the bench from the workspace's pinned member contributions.
 *
 * Serialized on the repo's mutation queue so an assembly never interleaves
 * with a land (or another assembly) in the same repository. Two different
 * projects assemble concurrently because they hold different queues.
 *
 * Returns an updated workspace record with per-member status and the new
 * `baseSha` / `lastBuiltAt` / `lastAssembly`. The caller persists it.
 */
export async function assembleBench(ws: IntegrationWorkspace): Promise<BenchAssembleResult> {
  const repo = repositoryManager.get(ws.repoPath)
  return repo.queue.enqueueMutation(() => assembleBenchUnqueued(ws))
}

/**
 * The assembly body without the queue wrapper. Exported for tests and for
 * callers already holding the repo mutation slot.
 */
export async function assembleBenchUnqueued(ws: IntegrationWorkspace): Promise<BenchAssembleResult> {
  log('assemble: starting', {
    repo_path: ws.repoPath,
    source_branch: ws.sourceBranch,
    bench_path: ws.benchPath,
    members_total: ws.members.length,
  })

  try {
    await ensureBenchWorktree(ws)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('assemble: could not prepare bench worktree', { bench_path: ws.benchPath, error: msg })
    return { ok: false, error: `Could not prepare the bench worktree: ${msg}` }
  }

  // ── A resolve-once merge in progress refuses the assembly ────────────────
  // `prepareConflictResolution` deliberately leaves a merge open in the bench
  // so the operator (or the AI assist) can resolve it — the completed merge is
  // what records the rerere resolution. Assembling now would `switch -C` out
  // of that merge and destroy the resolution mid-flight; git itself refuses
  // with "cannot switch branch while merging", but that surfaced as a raw
  // machinery error. Refuse first, with the actionable reason. This is a
  // typed refusal (like dirty-bench), not a failure: finish or abort the
  // resolution, then assemble.
  //
  // ── ...unless nothing is left to resolve ──────────────────────────────────
  // A merge can be open with ZERO unmerged paths: every conflict was resolved
  // and staged (by the operator, the AI assist, or rerere.autoUpdate) but
  // `merge --continue` was never run — the dialog closed, the assist tab was
  // dismissed, or the desktop restarted. That state needs no human decision;
  // the only remaining act is mechanical, and it is also the act that RECORDS
  // the resolution into rerere. Refusing here was the live defect: the
  // operator pressed Assemble repeatedly against a silent typed refusal while
  // the bar showed a stale "assembly failed". Complete the merge and proceed.
  if (benchMergeInProgress(ws.benchPath)) {
    const unmerged = await unmergedPaths(ws.benchPath)
    if (unmerged.length > 0) {
      log('assemble: refused, resolution merge in progress', {
        bench_path: ws.benchPath,
        unmerged_paths: unmerged.length,
      })
      return {
        ok: false,
        refusal: 'resolution-in-progress',
        error: 'A conflict resolution is in progress in the bench. Complete it (Continue) or abort it, then assemble.',
      }
    }
    try {
      await runGit(ws.benchPath, ['-c', 'core.editor=true', 'merge', '--continue'])
      log('assemble: completed a fully-resolved open merge before assembling', {
        bench_path: ws.benchPath,
        note: 'resolution recorded by rerere; assembly proceeds',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn('assemble: could not complete the open resolution merge', { bench_path: ws.benchPath, error: msg })
      return {
        ok: false,
        refusal: 'resolution-in-progress',
        error: `The bench has an open merge that could not be completed automatically: ${msg}`,
      }
    }
  }

  // Recordings must be active BEFORE any merge runs, or a conflict neither
  // replays an existing resolution nor records a new one.
  await ensureRerereEnabled(ws.benchPath)

  // Reset the bench to the source tip. `--discard-changes` resets TRACKED
  // files only; ignored build output survives, which is what keeps the
  // following build incremental. `resetBenchToTree` additionally runs
  // `clean -fd` (never `-x`) to remove untracked, non-ignored leftovers a
  // prior merge/abort can strand — see its doc comment in
  // bench-assemble-support.ts.
  try {
    await resetBenchToTree(ws.benchPath, ws.benchBranch, ws.sourceBranch)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('assemble: could not reset bench branch', { bench_path: ws.benchPath, bench_branch: ws.benchBranch, error: msg })
    return { ok: false, error: `Could not reset the bench branch: ${msg}` }
  }

  const baseSha = (await runGit(ws.benchPath, ['rev-parse', 'HEAD'])).trim()
  log('assemble: bench reset to source tip', { bench_branch: ws.benchBranch, base_sha: baseSha.slice(0, 7) })

  const merged: IntegrationMember[] = []
  const updatedMembers: IntegrationMember[] = []
  const retired: IntegrationMember[] = []
  const replayedRererePaths = new Set<string>()

  for (const member of ws.members) {
    // ── Empty contribution ────────────────────────────────────────────────
    // Checked BEFORE landed absorption, because the two are indistinguishable
    // by any live git query and the landed check would claim this member. A pin
    // that carries no commits has nothing to merge and nothing to absorb: the
    // member is simply enrolled ahead of its first commit, which is the natural
    // way to start work you intend to integrate.
    //
    // Reported as `pending` and KEPT. Retiring it was the defect: the member
    // vanished from the list on every assembly, so it could never be integrated.
    const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
    if (contribution.empty) {
      log('assemble: member pending, nothing to merge', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        base: contribution.baseSha.slice(0, 7),
        source_branch: ws.sourceBranch,
        note: 'enrolled with no commits of its own; commit then Update to integrate',
      })
      updatedMembers.push({
        ...member,
        // Backfilled for a legacy record so the next assembly answers from the
        // record instead of re-deriving it.
        pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
        // An empty pin is a PIN fact; there was nothing to merge, so the merge
        // axis records that no merge was attempted rather than claiming success.
        pin: 'empty',
        merge: 'skipped',
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
      })
      continue
    }

    // ── Landed absorption ─────────────────────────────────────────────────
    // Once a member's work is contained in the source branch it arrives with
    // the bench's base, so there is no member contribution left to merge.
    //
    // This is the land path: the operator lands a worktree into the FEATURE
    // branch (the workspace's source branch), typically after squashing a long
    // stream of commits into a tight set. From that point the work is part of
    // the feature branch permanently, so it is part of the bench without
    // option — sourced from the base rather than from the worktree. The bench
    // is functionally identical to what it was before the land.
    //
    // Absorption is purely a change to the BENCH's member list. It runs no git
    // command against the member worktree: the branch, its commits, and its
    // working tree are untouched and remain fully usable.
    if (await isLandedIntoSource(ws.benchPath, member, ws.sourceBranch)) {
      log('assemble: member landed into source, absorbed into base and retired', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        source_branch: ws.sourceBranch,
      })
      retired.push({
        ...member,
        pin: 'absorbed',
        // The content IS in the bench, sourced from the base rather than from a
        // merge of this member -- so `merged` would misattribute it.
        merge: 'skipped',
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
      })
      continue
    }

    if (!member.pinnedSha) {
      warn('assemble: member has no pinned contribution', { branch: member.branchName })
      updatedMembers.push({ ...member, pin: 'gone', merge: 'unbuilt', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined })
      continue
    }
    // A pinned commit whose object is gone (branch deleted and gc'd, worktree
    // removed) is `missing`, not a failure of the whole assembly.
    try {
      await runGit(ws.benchPath, ['cat-file', '-e', `${member.pinnedSha}^{commit}`])
    } catch {
      warn('assemble: member commit not found', { branch: member.branchName, sha: member.pinnedSha.slice(0, 7) })
      updatedMembers.push({ ...member, pin: 'gone', merge: 'unbuilt', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined })
      continue
    }

    // The branch names the contribution, and it is the identifier every git
    // verb uses. The member no longer carries a `label` copy of the worktree's
    // directory name -- that was one of the duplicated worktree fields the
    // sidecar removed, and the branch is the more useful of the two in a commit
    // message anyway.
    const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
    try {
      await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
      log('assemble: member merged', { branch: member.branchName, sha: member.pinnedSha.slice(0, 7) })
      merged.push(member)
      updatedMembers.push({
        ...member,
        // Backfilled for a legacy record so the range is present from now on.
        pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
        // The merge succeeded -- that is all this axis claims. Whether the
        // WORKTREE has since moved past the pin is a separate fact, preserved
        // here rather than overwritten, so a merged-but-behind member reports
        // both.
        merge: 'merged',
        pin: member.currentTreeHash && member.currentTreeHash !== member.pinnedTreeHash ? 'behind' : 'current',
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      // ── Replay a recorded resolution before declaring the conflict ───────
      // `git merge` already invoked rerere on the way down: a matching
      // recording is in the working tree and (autoUpdate) staged. If every
      // unmerged path was covered, the merge commits and the member reports
      // `merged` — flagged as replayed so the difference from a clean merge
      // stays observable in the record, the wire, and the logs.
      const replay = await tryReplayResolution(ws.benchPath, message, member.branchName, member.pinnedSha)
      if (replay.replayed) {
        for (const path of replay.rererePaths) replayedRererePaths.add(path)
        merged.push(member)
        updatedMembers.push({
          ...member,
          pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
          merge: 'merged',
          pin: member.currentTreeHash && member.currentTreeHash !== member.pinnedTreeHash ? 'behind' : 'current',
          conflictPaths: undefined,
          conflictsWith: undefined,
          mergeResolution: 'replayed',
        })
        continue
      }

      // ── Atomic failure ────────────────────────────────────────────────────
      // Capture the conflict detail while the merge is still in progress (the
      // unmerged index is the evidence), then abort and wipe. The whole
      // assembly fails: members merged before this point are NOT in the bench
      // after the wipe, so their merge axis says `unbuilt`, not `merged` —
      // claiming `merged` would describe a tree that no longer exists.
      const { paths, conflictsWith } = await describeConflict(
        ws.benchPath, merged, baseSha, member, ws.sourceBranch,
      )
      warn('assemble: member conflicted, assembly failed', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        conflict_paths: paths.length,
        conflicts_with: conflictsWith.join(','),
        failure_kind: paths.length > 0 ? 'conflict' : 'obstructed',
        error: msg,
      })
      try {
        await runGit(ws.benchPath, ['merge', '--abort'])
      } catch (abortErr) {
        log('assemble: merge --abort not needed or failed', { branch: member.branchName, error: String(abortErr) })
      }

      const reason = `${member.branchName}@${member.pinnedSha.slice(0, 7)} conflicted`
      await wipeBenchToEmpty(ws, reason)

      // ── Conflict vs. obstruction ──────────────────────────────────────────
      // See classifyMergeFailure's doc comment (bench-assemble-support.ts)
      // for why `paths.length === 0` is a structural signal, not a guess.
      const { failureKind, failureError } = classifyMergeFailure(member.branchName, paths, conflictsWith, msg)

      // Every member that is not THE conflicted one reports `unbuilt`: after
      // the wipe none of their content is in the bench, whatever happened
      // before the conflict. Pin facts are untouched — a conflicted member
      // that has also moved on keeps reporting `behind`, which is what tells
      // the operator whether Update is worth trying before resolving.
      // Prior decisions about these exact paths, so the surface that reports the
      // conflict also carries the context for resolving it. The same file
      // colliding once per member is the common case (rerere cannot help: its key
      // is the conflict text, which differs per member), and each of those
      // resolutions otherwise starts from nothing.
      const priorResolutions = paths.length > 0
        ? resolutionsFor(ws.repoPath, ws.sourceBranch, paths).map((r) => ({
          path: r.path,
          memberBranch: r.memberBranch,
          collidedWith: r.collidedWith,
          resolvedAt: r.resolvedAt,
          verified: r.verified,
          rationale: r.rationale,
        }))
        : []
      if (priorResolutions.length > 0) {
        log('assemble: conflict has prior recorded resolutions', {
          branch: member.branchName,
          conflict_paths: paths.length,
          prior_resolutions: priorResolutions.length,
        })
      }

      const failedMembers = ws.members.map((m): IntegrationMember => (
        m.worktreePath === member.worktreePath
          ? {
            ...m,
            merge: 'conflicted',
            conflictPaths: paths,
            conflictsWith,
            mergeResolution: undefined,
            priorResolutions: priorResolutions.length > 0 ? priorResolutions : undefined,
          }
          : { ...m, merge: 'unbuilt', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined, priorResolutions: undefined }
      ))

      const failed: IntegrationWorkspace = {
        ...ws,
        members: failedMembers,
        baseSha,
        lastBuiltAt: Date.now(),
        lastAssembly: 'failed',
        lastAssemblyError: failureError,
        lastAssemblyFailure: failureKind,
        lastAssemblyVerification: undefined,
      }
      log('assemble: failed atomically', {
        bench_path: ws.benchPath,
        conflicted_branch: member.branchName,
        conflict_paths: paths.length,
        conflicts_with: conflictsWith.join(','),
      })
      // ok:true — the ASSEMBLY ran and produced a definite, persisted outcome.
      // `ok:false` is reserved for the machinery failing (unpreparable
      // worktree, unresettable branch), where there is no outcome to record.
      return { ok: true, workspace: failed, retired }
    }
  }

  if (replayedRererePaths.size > 0) {
    const verification = await runBenchVerify(ws.repoPath, ws.benchPath)
    if (verification.ran && !verification.ok) {
      // ── Recordings are RETAINED, not forgotten ──────────────────────────
      // The earlier version called `forgetRererePaths` here and reported the
      // recordings "discarded" — but every merge in this loop is already
      // committed, so no MERGE_HEAD exists for `git rerere forget` to work
      // against. It silently forgot nothing while claiming it had (the live
      // defect this replaced). Deciding WHICH of the replayed recordings is
      // actually poisoned also is not this function's call: forgetting all of
      // them would discard every recording this assembly replayed to punish
      // one bad one, and Ion has no way to attribute the verify failure to a
      // specific recording without parsing project-specific build output it is
      // deliberately agnostic about. So recordings survive this failure, the
      // bench is wiped exactly as a conflict failure wipes it, and the
      // decision to discard becomes the operator's explicit, consented act
      // (the bench-verification recovery dialog) rather than an automatic one
      // that never actually worked.
      const replayedBranches = updatedMembers
        .filter((m) => replayedRererePaths.has(m.branchName) || m.mergeResolution === 'replayed')
        .map((m) => m.branchName)
      const outputTail = verification.output.slice(-1200)
      warn('assemble: replayed resolution failed project verification', {
        bench_path: ws.benchPath,
        replayed_paths: [...replayedRererePaths],
        replayed_branches: replayedBranches,
        command: verification.command,
        output_tail: outputTail,
        note: 'recordings retained; operator resolves via the verification-failure dialog',
      })
      const reason = 'recorded conflict resolution failed project verification'
      await wipeBenchToEmpty(ws, reason)
      const failureError = 'A recorded conflict resolution failed project verification. The bench is empty until this is resolved.'
      const failed: IntegrationWorkspace = {
        ...ws,
        members: updatedMembers.map((member) => ({
          ...member,
          merge: 'unbuilt',
          conflictPaths: undefined,
          conflictsWith: undefined,
          mergeResolution: undefined,
        })),
        baseSha,
        lastBuiltAt: Date.now(),
        lastAssembly: 'failed',
        lastAssemblyError: failureError,
        lastAssemblyFailure: 'verification',
        lastAssemblyVerification: {
          command: verification.command,
          outputTail,
          replayedBranches,
        },
      }
      return { ok: true, workspace: failed, retired }
    }
    log('assemble: replayed resolutions passed project verification', {
      bench_path: ws.benchPath,
      replayed_paths: [...replayedRererePaths],
      verification_ran: verification.ran,
    })
  } else {
    log('assemble: project verification skipped; no recorded resolution replayed', {
      bench_path: ws.benchPath,
    })
  }

  const result: IntegrationWorkspace = {
    ...ws,
    // Landed members are RETIRED from the list: a member represents pending
    // work to layer on top of the base, and landed work is no longer pending.
    // Its content lives in the source branch, which is where a pull request
    // into the trunk reads from, so nothing is lost by dropping the record.
    members: updatedMembers,
    baseSha,
    lastBuiltAt: Date.now(),
    lastAssembly: 'assembled',
    lastAssemblyError: undefined,
    lastAssemblyFailure: undefined,
    lastAssemblyVerification: undefined,
  }

  log('assemble: done', {
    bench_path: ws.benchPath,
    base_sha: baseSha.slice(0, 7),
    merged: merged.length,
    replayed: updatedMembers.filter((m) => m.mergeResolution === 'replayed').length,
    landed_retired: retired.length,
    empty_pin: updatedMembers.filter((m) => m.pin === 'empty').length,
    gone: updatedMembers.filter((m) => m.pin === 'gone').length,
    behind: updatedMembers.filter((m) => m.pin === 'behind').length,
  })
  return { ok: true, workspace: result, retired }
}
