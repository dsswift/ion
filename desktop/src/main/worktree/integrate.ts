/**
 * Worktree integration — landing a worktree branch into its source branch,
 * repeatably and without clobbering anyone's checkout.
 *
 * ── What was wrong before ───────────────────────────────────────────────────
 * The old GIT_WORKTREE_MERGE handler did, unconditionally:
 *
 *     git checkout <sourceBranch>      # in the MAIN repo
 *     git merge --ff-only <wtBranch>   # default strategy
 *
 * Three defects fall out of those two lines:
 *
 *   1. **Not repeatable.** `--ff-only` succeeds exactly once per source
 *      branch. As soon as a second worktree lands, the first worktree's next
 *      land is no longer a fast-forward and dies with a raw git error.
 *   2. **Clobbers the operator's checkout.** The bare `git checkout` runs with
 *      no preflight: if the main repo is mid-build, dirty, or sitting on a
 *      different branch, it either fails or yanks the working tree out from
 *      under a running build.
 *   3. **Races.** Two tabs landing at once both drive `checkout` in the same
 *      repo with no serialization.
 *
 * ── The approach ────────────────────────────────────────────────────────────
 * Pick the least destructive primitive that can do the job, decided by whether
 * the source branch is checked out anywhere:
 *
 *   - **Checked out nowhere** → `git fetch . <wtBranch>:<sourceBranch>`. This
 *     advances the ref with ZERO working-tree impact. Nobody's checkout moves,
 *     nothing can be clobbered, and it is safe to run while builds are going.
 *     git refuses this itself if it would not be a fast-forward, which is the
 *     correct guard rather than a check we have to write.
 *   - **Checked out somewhere** → merge in place in THAT worktree (which is
 *     usually the main repo, where the operator tests), after a preflight that
 *     refuses on a dirty tree with an actionable message. No `checkout` is ever
 *     issued: we merge where the branch already lives instead of moving a
 *     checkout to it.
 *
 * Repeatability comes from defaulting to a real merge (`--no-ff` when the
 * caller asks for it, plain merge otherwise) rather than `--ff-only`: the
 * second land onto a branch that has moved on is an ordinary merge.
 *
 * Every decision branch logs, so a refusal is diagnosable from
 * ~/.ion/desktop.jsonl alone.
 */
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { markWorktreeLanded, lookupWorktreeLandedAt } from './inventory'
import { disenrollWorktree } from '../integration/bench-ops'
import type { LandResult, WorktreeMoveResult } from '../../shared/types'
import { retireWorktreeUnqueued } from './relocate'

const TAG = 'worktree.land'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string
  branch: string
  head: string
}

/**
 * Parse `git worktree list --porcelain`. Shared by the land preflight and the
 * bench, so the porcelain format is understood in exactly one place.
 */
export function parseWorktreeList(raw: string): WorktreeListEntry[] {
  const worktrees: WorktreeListEntry[] = []
  for (const block of raw.trim().split('\n\n')) {
    if (!block.trim()) continue
    let path = ''
    let head = ''
    let branch = ''
    for (const line of block.trim().split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch refs/heads/'.length)
    }
    if (path) worktrees.push({ path, branch, head })
  }
  return worktrees
}

/**
 * Find the worktree (if any) that currently has `branch` checked out.
 * Returns null when the branch is checked out nowhere — the case that unlocks
 * the zero-impact ref advance.
 */
export async function findWorktreeForBranch(repoPath: string, branch: string): Promise<WorktreeListEntry | null> {
  try {
    const raw = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
    const match = parseWorktreeList(raw).find((w) => w.branch === branch)
    return match ?? null
  } catch (err) {
    // A failed probe must not silently downgrade into the destructive path:
    // callers treat null as "checked out nowhere", so surface the failure.
    warn('worktree list probe failed', { repo_path: repoPath, branch, error: String(err) })
    throw err
  }
}

/**
 * True when `directory` is sitting in a conflicted merge.
 *
 * Asks git for the unmerged index entries rather than pattern-matching the
 * failure text. Conflict messages ("CONFLICT (add/add): ...") go to git's
 * STDOUT, which the error path does not capture, and the wording is not a
 * stable interface — a string match silently misclassifies a genuine conflict
 * as an unknown error. The unmerged-index probe is the precise mechanism.
 */
export async function hasMergeConflict(directory: string): Promise<boolean> {
  try {
    const unmerged = await runGit(directory, ['ls-files', '--unmerged'])
    return unmerged.trim().length > 0
  } catch (err) {
    warn('conflict probe failed', { directory, error: String(err) })
    return false
  }
}

export interface LandOptions {
  repoPath: string
  worktreePath: string
  /** The worktree's own branch (the thing being landed). */
  worktreeBranch: string
  /** The branch being landed INTO. */
  sourceBranch: string
  /** Force a merge commit even when a fast-forward would do. */
  noFf?: boolean
  /**
   * Bring the source branch's commits into the worktree first. Reduces the
   * chance the integration itself conflicts, at the cost of rewriting the
   * worktree's history onto the new base.
   *
   * This is also what makes a linear (fast-forward) land POSSIBLE at all: once
   * the source tip is the worktree's base, the source branch is an ancestor of
   * the worktree branch and the merge degenerates to a pointer move. Without a
   * sync, any land onto a branch that has moved on necessarily writes a merge
   * commit — there is no third option.
   */
  syncFirst?: boolean
  /**
   * Refuse rather than write a merge commit.
   *
   * The honest complement to `syncFirst`. A caller asking for a linear history
   * wants "fast-forward, or tell me why not" — silently producing a merge
   * commit when the fast-forward is unavailable is the defect this exists to
   * prevent. With `syncFirst` the refusal should be rare; when it fires, the
   * message names the reason.
   */
  requireFastForward?: boolean
}

// The sync verb cluster (syncWorktreeFromSource, completeRebaseIfReplayed)
// lives in sync.ts; re-exported here so the many existing importers of the
// integration module keep one stable path for the whole lifecycle API.
import { syncWorktreeFromSource, isDirty } from './sync'
export { syncWorktreeFromSource, completeRebaseIfReplayed, isDirty } from './sync'

export interface LandAndRetireOptions extends LandOptions {
  /** Branch removed with the worktree after integration succeeds. */
  branchName: string
}

export interface LandAndRetireResult extends LandResult {
  /** True when integration completed, even if worktree cleanup failed. */
  landed?: boolean
  workingDirectory?: string
  recoveryRef?: string
}

/**
 * Integrate and remove a worktree as one terminal operation.
 *
 * Both halves run in one repository queue slot. If integration succeeded on a
 * prior attempt but removal failed, the landed registry witness selects a
 * cleanup-only retry instead of trying to integrate the same branch again.
 */
export async function landAndRetireWorktree(opts: LandAndRetireOptions): Promise<LandAndRetireResult> {
  const repo = repositoryManager.get(opts.repoPath)
  return repo.queue.enqueueMutation(async () => {
    const cleanupOnly = lookupWorktreeLandedAt(opts.worktreePath) != null
    log('land-and-retire: starting', {
      repo_path: opts.repoPath,
      worktree_path: opts.worktreePath,
      worktree_branch: opts.worktreeBranch,
      source_branch: opts.sourceBranch,
      cleanup_only: cleanupOnly,
    })

    let landResult: LandResult = { ok: true }
    if (!cleanupOnly) {
      landResult = await landWorktreeUnqueued(opts)
      if (!landResult.ok) {
        warn('land-and-retire: integration refused; worktree kept', {
          worktree_path: opts.worktreePath,
          has_conflicts: !!landResult.hasConflicts,
          error: landResult.error ?? '',
        })
        return landResult
      }
    } else {
      log('land-and-retire: prior integration found; retrying cleanup only', {
        worktree_path: opts.worktreePath,
      })
    }

    const retireResult: WorktreeMoveResult = await retireWorktreeUnqueued({
      repoPath: opts.repoPath,
      worktreePath: opts.worktreePath,
      branchName: opts.branchName,
    })
    const prunedBenchPaths = Array.from(new Set([
      ...(landResult.prunedBenchPaths ?? []),
      ...(retireResult.prunedBenchPaths ?? []),
    ]))
    if (!retireResult.ok) {
      warn('land-and-retire: integrated but cleanup failed', {
        worktree_path: opts.worktreePath,
        error: retireResult.error ?? '',
      })
      return {
        ...landResult,
        ok: false,
        landed: true,
        error: `Land succeeded, but worktree removal failed: ${retireResult.error ?? 'Unknown error.'}`,
        prunedBenchPaths,
      }
    }

    log('land-and-retire: done', {
      worktree_path: opts.worktreePath,
      cleanup_only: cleanupOnly,
      pruned_benches: prunedBenchPaths.length,
    })
    return {
      ...landResult,
      ...retireResult,
      ok: true,
      landed: true,
      prunedBenchPaths,
      warning: retireResult.warning ?? landResult.warning,
    }
  })
}

/**
 * Land a worktree's branch into its source branch.
 *
 * Serialized on the repo's mutation queue, so concurrent lands from several
 * tabs (or a land racing a bench assembly) never interleave git mutations in
 * the same repository.
 */
export async function landWorktree(opts: LandOptions): Promise<LandResult> {
  const repo = repositoryManager.get(opts.repoPath)
  return repo.queue.enqueueMutation(() => landWorktreeUnqueued(opts))
}

/**
 * The land body, without the queue wrapper. Exported for tests and for
 * callers that already hold the repo mutation slot (never call this from a
 * path that is not already serialized).
 */
export async function landWorktreeUnqueued(opts: LandOptions): Promise<LandResult> {
  const { repoPath, worktreePath, worktreeBranch, sourceBranch, noFf, syncFirst, requireFastForward } = opts
  log('land: starting', {
    repo_path: repoPath,
    worktree_path: worktreePath,
    worktree_branch: worktreeBranch,
    source_branch: sourceBranch,
    no_ff: !!noFf,
    sync_first: !!syncFirst,
    require_fast_forward: !!requireFastForward,
  })

  // ── Gate 0: landed is terminal ────────────────────────────────────────────
  const alreadyLandedAt = lookupWorktreeLandedAt(worktreePath)
  if (alreadyLandedAt != null) {
    warn('land: refused, worktree already landed', { worktree_path: worktreePath, landed_at: alreadyLandedAt })
    return { ok: false, error: 'This worktree has already been landed. Land is a terminal operation.' }
  }

  // ── Gate 1: the worktree must be committed ────────────────────────────────
  // Landing uncommitted work is not possible (there is no commit to merge),
  // and silently landing a subset would be worse than refusing.
  try {
    if (await isDirty(worktreePath)) {
      warn('land: refused, worktree has uncommitted changes', { worktree_path: worktreePath })
      return { ok: false, error: 'Commit the changes in this worktree before landing.' }
    }
  } catch (err) {
    warn('land: worktree status probe failed', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not read worktree status: ${String(err)}` }
  }
  log('land: worktree clean', { worktree_path: worktreePath })

  // ── Optional sync ─────────────────────────────────────────────────────────
  if (syncFirst) {
    const synced = await syncWorktreeFromSource(worktreePath, sourceBranch)
    if (!synced.ok) {
      // A pre-sync conflict is left in the WORKTREE, not in the source
      // branch's holder — name it so the caller resolves the right checkout.
      return {
        ok: false,
        error: `Sync from ${sourceBranch} failed: ${synced.error}`,
        hasConflicts: synced.hasConflicts,
        conflictDirectory: synced.hasConflicts ? worktreePath : undefined,
      }
    }
  }

  // ── Decide the integration primitive ──────────────────────────────────────
  let holder: WorktreeListEntry | null
  try {
    holder = await findWorktreeForBranch(repoPath, sourceBranch)
  } catch (err) {
    return { ok: false, error: `Could not determine where ${sourceBranch} is checked out: ${String(err)}` }
  }

  if (!holder) {
    // Nobody has the source branch checked out: advance the ref directly.
    // No working tree is touched, so this is safe during a running build.
    log('land: source branch checked out nowhere, advancing ref', { source_branch: sourceBranch })
    try {
      await runGit(repoPath, ['fetch', '.', `${worktreeBranch}:${sourceBranch}`])
      const sha = (await runGit(repoPath, ['rev-parse', sourceBranch])).trim()
      log('land: ref advanced', { source_branch: sourceBranch, sha: sha.slice(0, 7) })
      // The only moment this is knowable. See the `landedAt` field comment:
      // after the fact, a landed worktree and one that never committed are
      // indistinguishable to git.
      const landWarning = markWorktreeLanded(worktreePath)
        ? undefined
        : 'Land succeeded but the registry could not be updated.'
      if (landWarning) {
        warn('land: ref advanced but registry persist failed', { worktree_path: worktreePath })
        return { ok: true, mode: 'ref-advance', sha, warning: landWarning }
      }
      const prunedBenchPaths = await disenrollAfterLand(repoPath, worktreePath)
      return { ok: true, mode: 'ref-advance', sha, prunedBenchPaths }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // git refuses a non-fast-forward ref update itself. That is the honest
      // outcome: the source branch has moved on in a way this worktree has not
      // seen, and the operator should sync first.
      warn('land: ref advance rejected', { source_branch: sourceBranch, worktree_branch: worktreeBranch, error: msg })
      return {
        ok: false,
        error:
          `Cannot fast-forward ${sourceBranch} from ${worktreeBranch}: the source branch has moved on. ` +
          `Sync this worktree from ${sourceBranch} first, then land again.`,
      }
    }
  }

  // ── In-place merge in whichever worktree holds the source branch ──────────
  // Deliberately NO `git checkout`: we merge where the branch already lives,
  // rather than dragging a checkout onto it.
  log('land: source branch checked out, merging in place', { source_branch: sourceBranch, holder_path: holder.path })

  try {
    if (await isDirty(holder.path)) {
      warn('land: refused, holder worktree dirty', { holder_path: holder.path, source_branch: sourceBranch })
      return {
        ok: false,
        error:
          `${sourceBranch} is checked out at ${holder.path} with uncommitted changes. ` +
          'Commit or stash them there, then land again.',
      }
    }
  } catch (err) {
    warn('land: holder status probe failed', { holder_path: holder.path, error: String(err) })
    return { ok: false, error: `Could not read the status of ${holder.path}: ${String(err)}` }
  }

  const mergeArgs = noFf
    ? ['merge', '--no-ff', '-m', `Merge ${worktreeBranch} into ${sourceBranch}`, worktreeBranch]
    : requireFastForward
      // `--ff-only` makes the promise enforceable: git refuses rather than
      // silently writing a merge commit. A caller that asked for a linear
      // history gets one or gets told why not — never a merge commit it did
      // not ask for. That silent substitution is exactly what a plain `merge`
      // does when the branches have diverged, and it is the defect this
      // branch exists to prevent.
      ? ['merge', '--ff-only', worktreeBranch]
      : ['merge', '-m', `Merge ${worktreeBranch} into ${sourceBranch}`, worktreeBranch]
  try {
    await runGit(holder.path, mergeArgs)
    const sha = (await runGit(holder.path, ['rev-parse', 'HEAD'])).trim()
    log('land: merged', {
      source_branch: sourceBranch,
      holder_path: holder.path,
      sha: sha.slice(0, 7),
      no_ff: !!noFf,
      require_fast_forward: !!requireFastForward,
    })
    const mergeWarning = markWorktreeLanded(worktreePath)
      ? undefined
      : 'Land succeeded but the registry could not be updated.'
    if (mergeWarning) {
      warn('land: merged but registry persist failed', { worktree_path: worktreePath })
      return { ok: true, mode: requireFastForward ? 'fast-forward' : 'merge', sha, warning: mergeWarning }
    }
    const prunedBenchPaths = await disenrollAfterLand(repoPath, worktreePath)
    return { ok: true, mode: requireFastForward ? 'fast-forward' : 'merge', sha, prunedBenchPaths }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Ask git whether this is actually a conflict rather than pattern-matching
    // the message: the "CONFLICT (...)" lines go to stdout, not the captured
    // stderr, so a text match would misreport a real conflict as an unknown
    // failure. See hasMergeConflict.
    const conflicted = await hasMergeConflict(holder.path)
    warn('land: merge failed', { source_branch: sourceBranch, holder_path: holder.path, has_conflicts: conflicted, error: msg })
    if (conflicted) {
      return {
        ok: false,
        hasConflicts: true,
        // The merge runs in whichever checkout holds the source branch, so the
        // conflict is there — usually the base repo, never this worktree.
        conflictDirectory: holder.path,
        error: `Merge conflict landing ${worktreeBranch} into ${sourceBranch}. Resolve it in ${holder.path}, then land again.`,
      }
    }
    // A --ff-only refusal is not a conflict and not an unknown failure: it is
    // the guard working. Say what happened and what fixes it, rather than
    // surfacing git's raw "Not possible to fast-forward, aborting."
    if (requireFastForward) {
      return {
        ok: false,
        error:
          `Cannot fast-forward ${sourceBranch} from ${worktreeBranch}: the source branch has commits this ` +
          `worktree does not have. Sync this worktree from ${sourceBranch} first, then land again — or land ` +
          `with a merge commit instead.`,
      }
    }
    return { ok: false, error: msg }
  }
}

/**
 * After a successful land, disenroll the worktree from every bench and remove
 * any bench left empty. Same pattern as retire (relocate.ts), split out so both
 * success paths share a single call.
 */
async function disenrollAfterLand(repoPath: string, worktreePath: string): Promise<string[]> {
  let result: { removedFrom: number; prunedBenches: string[] }
  try {
    result = disenrollWorktree(worktreePath)
  } catch (err) {
    // The source branch already contains the work. Preserve the sealed registry
    // witness and report cleanup separately instead of lying that nothing landed.
    warn('land: bench disenrollment failed after successful integration', {
      worktree_path: worktreePath,
      error: String(err),
    })
    return []
  }
  const { removedFrom, prunedBenches } = result
  if (removedFrom > 0) {
    log('land: disenrolled from bench(es)', {
      worktree_path: worktreePath,
      benches: removedFrom,
      pruned: prunedBenches.length,
    })
  }
  for (const benchPath of prunedBenches) {
    try {
      await runGit(repoPath, ['worktree', 'remove', benchPath, '--force'])
      log('land: removed pruned bench worktree', { bench_path: benchPath })
    } catch (err) {
      log('land: pruned bench worktree removal skipped', { bench_path: benchPath, error: String(err) })
    }
  }
  return prunedBenches
}
