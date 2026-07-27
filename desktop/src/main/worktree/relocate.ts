/**
 * Worktree retire and re-attach — the two moves that let a conversation
 * outlive its worktree.
 *
 * Both are deliberately split from the CONVERSATION side of the operation.
 * These functions only do the git work and return the directory the caller
 * should relocate the conversation into; the caller then invokes
 * `relocateSession` (engine-control-plane-relocate.ts). Keeping them separate
 * means the git result and the conversation move are independently
 * observable, and a failed relocation never leaves a half-removed worktree
 * looking like a success.
 *
 * - **Retire**: the work has landed, the worktree is no longer needed, but the
 *   CONVERSATION is not finished. Remove the worktree and its branch, and hand
 *   back the repo root so the conversation continues there. This is what the
 *   old fused "Finish work" could not do — it always closed the tab.
 * - **Re-attach**: the conversation is alive at the repo root (or anywhere)
 *   and needs isolation again — typically a bug found after the merge. Cut a
 *   fresh worktree from the CURRENT source tip and hand back its path, so the
 *   same conversation continues in a clean isolated tree with no re-priming.
 */
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { basename, join } from 'path'
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { registerWorktree, unregisterWorktree } from './inventory'
import { disenrollWorktree } from '../integration/bench-ops'
import type { WorktreeInfo, WorktreeMoveResult } from '../../shared/types'

const TAG = 'worktree.move'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface RetireOptions {
  repoPath: string
  worktreePath: string
  branchName: string
  /**
   * Remove even when the worktree has uncommitted changes. Default false: an
   * accidental retire must not silently destroy work.
   */
  force?: boolean
}

/**
 * Remove a worktree and its branch, returning the repo root for the caller to
 * relocate the conversation into.
 *
 * Refuses by default when the worktree is dirty — the whole point of retiring
 * is that the work has already landed, so uncommitted changes mean something
 * is off and the operator should look.
 */
export async function retireWorktree(opts: RetireOptions): Promise<WorktreeMoveResult> {
  const { repoPath, worktreePath, branchName, force } = opts
  const repo = repositoryManager.get(repoPath)
  return repo.queue.enqueueMutation(async () => {
    log('retire: starting', { repo_path: repoPath, worktree_path: worktreePath, branch: branchName, force: !!force })

    if (!force) {
      try {
        const status = await runGit(worktreePath, ['status', '--porcelain'])
        if (status.trim().length > 0) {
          warn('retire: refused, worktree has uncommitted changes', { worktree_path: worktreePath })
          return {
            ok: false,
            error: 'This worktree has uncommitted changes. Commit or discard them before retiring it.',
          }
        }
      } catch (err) {
        // The worktree directory may already be gone (removed outside Ion).
        // That is not a reason to refuse — proceed to the removal, which
        // handles the already-absent case via `git worktree remove`/prune.
        log('retire: status probe failed, continuing to removal', { worktree_path: worktreePath, error: String(err) })
      }
    }

    try {
      const removeArgs = ['worktree', 'remove', worktreePath]
      if (force) removeArgs.push('--force')
      await runGit(repoPath, removeArgs)
      log('retire: worktree removed', { worktree_path: worktreePath })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn('retire: worktree remove failed', { worktree_path: worktreePath, error: msg })
      return { ok: false, error: msg }
    }

    // Branch deletion is best-effort and INTENTIONALLY non-fatal: the worktree
    // is already gone, so a retained branch is a harmless leftover rather than
    // a failure the operator must act on. `-D` (not `-d`) because the branch
    // has usually just been landed via a merge commit, which `-d` may not
    // recognize as merged depending on the integration mode.
    try {
      await runGit(repoPath, ['branch', '-D', branchName])
      log('retire: branch deleted', { branch: branchName })
    } catch (err) {
      log('retire: branch delete skipped (worktree already removed)', { branch: branchName, error: String(err) })
    }

    unregisterWorktree(worktreePath)

    // Drop the worktree from every bench that held it, and remove any bench
    // left empty. A member whose worktree is gone can never be updated,
    // rebuilt from, or landed -- it would sit as a permanent `missing` row.
    // Enrollment stays manual (it is a judgement); disenrollment is bookkeeping
    // catching up with reality, so it is automatic.
    const { removedFrom, prunedBenches } = disenrollWorktree(worktreePath)
    if (removedFrom > 0) {
      log('retire: disenrolled from bench(es)', {
        worktree_path: worktreePath,
        benches: removedFrom,
        pruned: prunedBenches.length,
      })
    }
    // Remove the git worktree for any bench pruned above. Best-effort and
    // logged: a leftover bench directory is clutter, never lost work (its
    // content is exactly the feature branch).
    for (const benchPath of prunedBenches) {
      try {
        await runGit(repoPath, ['worktree', 'remove', benchPath, '--force'])
        log('retire: removed pruned bench worktree', { bench_path: benchPath })
      } catch (err) {
        log('retire: pruned bench worktree removal skipped', { bench_path: benchPath, error: String(err) })
      }
    }

    pruneEmptyParent(worktreePath)

    log('retire: done', { worktree_path: worktreePath, relocate_to: repoPath })
    return { ok: true, workingDirectory: repoPath }
  })
}

export interface ReattachOptions {
  repoPath: string
  /** Branch to cut the new worktree from; its CURRENT tip is used. */
  sourceBranch: string
}

/**
 * Create a fresh worktree from the current tip of `sourceBranch`, returning
 * its path so the caller can relocate an existing conversation into it.
 *
 * Mirrors the naming and layout of the original worktree-add path
 * (`~/.ion/worktrees/<repo>-<id>` on a `wt/<hex>` branch) so a re-attached
 * worktree is indistinguishable from an originally-created one to every other
 * part of the system.
 */
export async function reattachWorktree(opts: ReattachOptions): Promise<WorktreeMoveResult> {
  const { repoPath, sourceBranch } = opts
  const repo = repositoryManager.get(repoPath)
  return repo.queue.enqueueMutation(async () => {
    log('reattach: starting', { repo_path: repoPath, source_branch: sourceBranch })
    try {
      const id = randomBytes(4).toString('hex')
      const branchName = `wt/${randomBytes(4).toString('hex')}`
      const worktreeDir = join(homedir(), '.ion', 'worktrees')
      const worktreePath = join(worktreeDir, `${basename(repoPath)}-${id}`)
      mkdirSync(worktreeDir, { recursive: true })
      await runGit(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, sourceBranch])
      const worktree: WorktreeInfo = { worktreePath, branchName, sourceBranch, repoPath }
      // A re-attached worktree must be indistinguishable from an originally
      // created one, so it registers its source branch the same way.
      registerWorktree({ worktreePath, repoPath, branchName, sourceBranch })
      log('reattach: created', { worktree_path: worktreePath, branch: branchName, source_branch: sourceBranch })
      return { ok: true, workingDirectory: worktreePath, worktree }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn('reattach: failed', { repo_path: repoPath, source_branch: sourceBranch, error: msg })
      return { ok: false, error: msg }
    }
  })
}

/**
 * Remove the worktree parent directory when the last worktree in it is gone.
 * Best-effort housekeeping; a leftover empty directory is harmless.
 */
function pruneEmptyParent(worktreePath: string): void {
  try {
    const parent = join(worktreePath, '..')
    if (readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true })
      log('retire: pruned empty worktree parent', { parent })
    }
  } catch (err) {
    log('retire: parent prune skipped', { worktree_path: worktreePath, error: String(err) })
  }
}
