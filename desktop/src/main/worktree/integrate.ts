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
import type { LandResult } from '../../shared/types'

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

/** True when the given working tree has uncommitted changes. */
export async function isDirty(directory: string): Promise<boolean> {
  const status = await runGit(directory, ['status', '--porcelain'])
  return status.trim().length > 0
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
   */
  syncFirst?: boolean
}

/**
 * Rebase a worktree onto the current tip of its source branch.
 *
 * Exposed on its own (the "Sync from source" verb) and reused as the optional
 * first step of a land. This is the resolution for BASE staleness: the feature
 * branch has moved on — because another worktree landed, a teammate pushed, or
 * the operator committed to it directly — and this worktree is developing
 * against stale code.
 *
 * A dirty worktree is REFUSED before git is asked to rebase. git would refuse
 * anyway ("cannot rebase: You have unstaged changes"), so the operator's work
 * is never at risk either way — but the raw git error is not actionable, and a
 * preflight lets the caller say what to do about it. The uncommitted work is
 * left exactly as it was.
 */
export async function syncWorktreeFromSource(
  worktreePath: string,
  sourceBranch: string,
): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean; refusedDirty?: boolean }> {
  log('sync: starting', { worktree_path: worktreePath, source_branch: sourceBranch })

  // Preflight: refuse a dirty tree with an actionable message rather than
  // letting git emit its own. Nothing is modified on this path.
  try {
    if (await isDirty(worktreePath)) {
      warn('sync: refused, worktree has uncommitted changes', { worktree_path: worktreePath })
      return {
        ok: false,
        refusedDirty: true,
        error:
          'This worktree has uncommitted changes, so it cannot be synced. ' +
          'Commit or stash them, then sync again. Your changes have not been touched.',
      }
    }
  } catch (err) {
    warn('sync: status probe failed', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not read worktree status: ${String(err)}` }
  }

  try {
    await runGit(worktreePath, ['rebase', sourceBranch])
    log('sync: done', { worktree_path: worktreePath, source_branch: sourceBranch })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Precise conflict detection, not a message match — see hasMergeConflict.
    const hasConflicts = await hasMergeConflict(worktreePath)
    warn('sync: failed', { worktree_path: worktreePath, source_branch: sourceBranch, has_conflicts: hasConflicts, error: msg })
    if (hasConflicts) {
      return {
        ok: false,
        hasConflicts: true,
        error:
          `Syncing from ${sourceBranch} hit a conflict. Resolve it in ${worktreePath} ` +
          '(git rebase --continue), or run git rebase --abort to return to where you were.',
      }
    }
    return { ok: false, error: msg }
  }
}

/**
 * Land a worktree's branch into its source branch.
 *
 * Serialized on the repo's mutation queue, so concurrent lands from several
 * tabs (or a land racing a bench rebuild) never interleave git mutations in
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
  const { repoPath, worktreePath, worktreeBranch, sourceBranch, noFf, syncFirst } = opts
  log('land: starting', {
    repo_path: repoPath,
    worktree_path: worktreePath,
    worktree_branch: worktreeBranch,
    source_branch: sourceBranch,
    no_ff: !!noFf,
    sync_first: !!syncFirst,
  })

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
      return { ok: false, error: `Sync from ${sourceBranch} failed: ${synced.error}`, hasConflicts: synced.hasConflicts }
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
      return { ok: true, mode: 'ref-advance', sha }
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
    : ['merge', '-m', `Merge ${worktreeBranch} into ${sourceBranch}`, worktreeBranch]
  try {
    await runGit(holder.path, mergeArgs)
    const sha = (await runGit(holder.path, ['rev-parse', 'HEAD'])).trim()
    log('land: merged', { source_branch: sourceBranch, holder_path: holder.path, sha: sha.slice(0, 7), no_ff: !!noFf })
    return { ok: true, mode: 'merge', sha }
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
        error: `Merge conflict landing ${worktreeBranch} into ${sourceBranch}. Resolve it in ${holder.path}, then land again.`,
      }
    }
    return { ok: false, error: msg }
  }
}
