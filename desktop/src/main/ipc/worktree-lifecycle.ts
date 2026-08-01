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
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { landWorktree, syncWorktreeFromSource } from '../worktree/integrate'
import { retireWorktree, reattachWorktree } from '../worktree/relocate'
import { appraiseBase } from '../worktree/base-staleness'
import { inventoryWorktrees, lookupWorktreeRegistration } from '../worktree/inventory'
import { appraiseWorktree } from '../worktree/safety'

const TAG = 'worktree.ipc'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function registerWorktreeLifecycleIpc(): void {
  ipcMain.handle(
    IPC.GIT_WORKTREE_LAND,
    async (
      _event,
      { repoPath, worktreePath, worktreeBranch, sourceBranch, noFf, syncFirst, requireFastForward }:
        { repoPath: string; worktreePath: string; worktreeBranch: string; sourceBranch: string; noFf?: boolean; syncFirst?: boolean; requireFastForward?: boolean },
    ) => {
      log('land request', { repo_path: repoPath, worktree_branch: worktreeBranch, source_branch: sourceBranch, no_ff: !!noFf, sync_first: !!syncFirst, require_fast_forward: !!requireFastForward })
      const result = await landWorktree({ repoPath, worktreePath, worktreeBranch, sourceBranch, noFf, syncFirst, requireFastForward })
      if (!result.ok) {
        warn('land refused', { worktree_branch: worktreeBranch, source_branch: sourceBranch, has_conflicts: !!result.hasConflicts, error: result.error ?? '' })
      } else {
        log('land ok', { worktree_branch: worktreeBranch, source_branch: sourceBranch, mode: result.mode ?? '', sha: (result.sha ?? '').slice(0, 7) })
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
        log('sync ok', { worktree_path: worktreePath, source_branch: sourceBranch })
      }
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
      })
      return { registration }
    },
  )

  ipcMain.handle(
    IPC.GIT_WORKTREE_INVENTORY,
    async (_event, { repoPath }: { repoPath: string }) => {
      const worktrees = await inventoryWorktrees(repoPath)
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

  ipcMain.handle(
    IPC.GIT_WORKTREE_RETIRE,
    async (
      _event,
      { repoPath, worktreePath, branchName, force }:
        { repoPath: string; worktreePath: string; branchName: string; force?: boolean },
    ) => {
      log('retire request', { repo_path: repoPath, worktree_path: worktreePath, branch: branchName, force: !!force })
      const result = await retireWorktree({ repoPath, worktreePath, branchName, force })
      if (!result.ok) {
        warn('retire refused', { worktree_path: worktreePath, error: result.error ?? '' })
      } else {
        log('retire ok', { worktree_path: worktreePath, relocate_to: result.workingDirectory ?? '' })
      }
      return result
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
