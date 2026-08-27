/**
 * IPC surface for the worktree lifecycle verbs.
 *
 * Kept separate from `ipc/worktree.ts` (which owns the original
 * add/remove/list/status/push primitives) because these are the higher-level
 * operator verbs — land, sync, retire, re-attach — and each composes several
 * git operations behind a preflight. See `main/worktree/integrate.ts` and
 * `main/worktree/relocate.ts` for the mechanics and the rationale.
 *
 * All four are request/response (`handle`, not `on`): every one of them can
 * legitimately refuse, and the caller must know before it takes the next step
 * (a retire that proceeded after a failed land would destroy unlanded work).
 */
import { ipcMain } from 'electron'
import { broadcast } from '../broadcast'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { landAndRetireWorktree, syncWorktreeFromSource } from '../worktree/integrate'
import { syncAllWorktrees } from '../worktree/sync-all'
import { reattachWorktree, discardWorktree } from '../worktree/relocate'
import { appraiseBase } from '../worktree/base-staleness'
import { lookupWorktreeRegistration } from '../worktree/inventory'
import { getWorktreeInventory } from '../worktree/inventory-service'
import { appraiseWorktree } from '../worktree/safety'
import { predictPrunedBenches } from '../integration/bench-ops'

const TAG = 'worktree.ipc'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function registerWorktreeLifecycleIpc(): void {
  ipcMain.handle(
    IPC.GIT_WORKTREE_LAND_AND_RETIRE,
    async (
      _event,
      { repoPath, worktreePath, worktreeBranch, branchName, sourceBranch, noFf, syncFirst, requireFastForward }:
        { repoPath: string; worktreePath: string; worktreeBranch: string; branchName?: string; sourceBranch: string; noFf?: boolean; syncFirst?: boolean; requireFastForward?: boolean },
    ) => {
      const resolvedBranch = branchName ?? worktreeBranch
      log('land-and-retire request', {
        repo_path: repoPath, worktree_path: worktreePath, worktree_branch: worktreeBranch,
        source_branch: sourceBranch, no_ff: !!noFf, sync_first: !!syncFirst,
        require_fast_forward: !!requireFastForward,
      })
      const result = await landAndRetireWorktree({
        repoPath, worktreePath, worktreeBranch, branchName: resolvedBranch,
        sourceBranch, noFf, syncFirst, requireFastForward,
      })
      if (!result.ok) {
        warn('land-and-retire failed', {
          worktree_branch: worktreeBranch, source_branch: sourceBranch,
          landed: !!result.landed, has_conflicts: !!result.hasConflicts, error: result.error ?? '',
        })
      } else {
        log('land-and-retire ok', {
          worktree_branch: worktreeBranch, source_branch: sourceBranch,
          mode: result.mode ?? '', sha: (result.sha ?? '').slice(0, 7),
        })
        broadcast('ion:worktree-landed', {
          repoPath,
          worktreePath,
          prunedBenchPaths: result.prunedBenchPaths ?? [],
        })
      }
      return result
    },
  )

  ipcMain.handle(
    IPC.GIT_WORKTREE_DISCARD,
    async (_event, { repoPath, worktreePath, branchName, sourceBranch }: { repoPath: string; worktreePath: string; branchName: string; sourceBranch: string }) => {
      log('discard request', {
        repo_path: repoPath,
        worktree_path: worktreePath,
        branch: branchName,
        source_branch: sourceBranch,
      })
      const result = await discardWorktree({ repoPath, worktreePath, branchName, sourceBranch })
      if (!result.ok) {
        warn('discard refused', { worktree_path: worktreePath, error: result.error ?? '' })
      } else {
        log('discard ok', {
          worktree_path: worktreePath,
          recovery_ref: result.recoveryRef ?? '',
          pruned_benches: result.prunedBenchPaths?.length ?? 0,
        })
      }
      return result
    },
  )


  ipcMain.handle(
    IPC.GIT_WORKTREE_SYNC,
    async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
      log('sync request', { worktree_path: worktreePath, source_branch: sourceBranch })
      const result = await syncWorktreeFromSource(worktreePath, sourceBranch)
      if (!result.ok) {
        warn('sync failed', {
          worktree_path: worktreePath,
          source_branch: sourceBranch,
          has_conflicts: !!result.hasConflicts,
          refused_dirty: !!result.refusedDirty,
          error: result.error ?? '',
        })
      } else {
        log('sync ok', { worktree_path: worktreePath, source_branch: sourceBranch, replayed: !!result.replayed })
      }
      return result
    },
  )

  // The bulk pass. One request/response for the whole board: the caller gets
  // the per-worktree outcome list, which is what the pipeline's confirm gate
  // and the progress UI render. Sequencing and rerere cascade live in
  // main/worktree/sync-all.ts.
  ipcMain.handle(
    IPC.GIT_WORKTREE_SYNC_ALL,
    async (_event, { repoPath }: { repoPath: string }) => {
      log('sync-all request', { repo_path: repoPath })
      const result = await syncAllWorktrees(repoPath)
      log('sync-all done', { repo_path: repoPath, ...result.summary })
      return result
    },
  )

  // Inventory — the answer to "what worktrees exist here, and how do I get
  // back into one?". Read-only; the re-entry surface depends on it, so it must
  // never mutate anything.
  /**
   * The registry's answer for one worktree: which repo it belongs to, what
   * branch it is, and what it was cut from.
   *
   * Exists because the renderer's `worktreeInventory` map is a DISPLAY cache
   * keyed by whatever path the panel last queried -- which, from a bench, is the
   * bench path. Deriving a worktree's owning repo by scanning that map returned
   * the bench, and that wrong repoPath was then written onto the tab. The
   * registry is the authoritative record; this is the only correct source.
   */
  ipcMain.handle(
    IPC.GIT_WORKTREE_REGISTRATION,
    async (_event, { worktreePath }: { worktreePath: string }) => {
      const registration = lookupWorktreeRegistration(worktreePath)
      if (!registration) {
        log('worktree registration lookup: no record', { worktree_path: worktreePath })
        return { registration: null }
      }
      log('worktree registration lookup', {
        worktree_path: worktreePath,
        repo_path: registration.repoPath,
        source_branch: registration.sourceBranch ?? 'unknown',
        landed: !!registration.landedAt,
      })
      return { registration }
    },
  )

  ipcMain.handle(
    IPC.GIT_WORKTREE_INVENTORY,
    async (_event, { repoPath }: { repoPath: string }) => {
      // Through the service, never the raw crawl: both renderer windows poll
      // this channel on an interval, and the service is what coalesces them
      // into one bounded crawl (see worktree/inventory-service.ts).
      const worktrees = await getWorktreeInventory(repoPath)
      log('inventory', { repo_path: repoPath, count: worktrees.length })
      return { worktrees }
    },
  )

  // Appraisal for the close/discard confirmation: what would be lost.
  ipcMain.handle(
    IPC.GIT_WORKTREE_APPRAISE,
    async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
      const appraisal = await appraiseWorktree(worktreePath, sourceBranch)
      log('appraise', {
        worktree_path: worktreePath,
        safe_to_discard: appraisal.safeToDiscard,
        uncommitted: appraisal.uncommittedPaths.length,
        unlanded: appraisal.unlandedCommitCount,
      })
      return appraisal
    },
  )

  // Base staleness — the OTHER direction of staleness from bench staleness.
  // Bench staleness says "the worktree moved ahead of the bench"; this says
  // "the feature branch moved ahead of the worktree". Read-only.
  ipcMain.handle(
    IPC.GIT_WORKTREE_BASE_STATUS,
    async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
      const result = await appraiseBase(worktreePath, sourceBranch)
      log('base status', {
        worktree_path: worktreePath,
        source_branch: sourceBranch,
        behind: result.behindCount,
        needs_sync: result.needsSync,
      })
      return result
    },
  )

  // Read-only: answers "what else would this retire delete?" so the caller can
  // pre-flight its refusal before anything is destroyed. Separate from the
  // retire itself because it must be safe to call when the operator has not
  // committed to anything — it mutates nothing and can be called from a menu
  // handler on every open.
  ipcMain.handle(
    IPC.GIT_WORKTREE_RETIRE_PREVIEW,
    (_event, { worktreePath }: { worktreePath: string }) => {
      const prunedBenchPaths = predictPrunedBenches(worktreePath)
      log('retire preview', { worktree_path: worktreePath, pruned_benches: prunedBenchPaths.length })
      return { prunedBenchPaths }
    },
  )

  ipcMain.handle(
    IPC.GIT_WORKTREE_REATTACH,
    async (_event, { repoPath, sourceBranch, title }: { repoPath: string; sourceBranch: string; title?: string }) => {
      log('reattach request', { repo_path: repoPath, source_branch: sourceBranch, title: title ?? '' })
      const result = await reattachWorktree({ repoPath, sourceBranch, title })
      if (!result.ok) {
        warn('reattach failed', { repo_path: repoPath, source_branch: sourceBranch, error: result.error ?? '' })
      } else {
        log('reattach ok', { worktree_path: result.workingDirectory ?? '' })
      }
      return result
    },
  )
}
