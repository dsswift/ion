/**
 * IPC surface for the integration workspace (the bench).
 *
 * Every mutation is operator-triggered: nothing here runs on a timer or in
 * response to a file change. Assemble re-merges existing pins; only the Update
 * verbs advance a pin. See main/integration/bench-ops.ts for that split.
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import {
  listWorkspaces, ensureWorkspace, addMember, removeMember, setMemberEnabled,
  setMemberReview, setMemberOrder,
  updateMember, updateAllStale, assembleWorkspace, refreshStaleness, sourceBranchTip,
} from '../integration/bench-ops'
import { prepareConflictResolution } from '../integration/bench-resolve'

const TAG = 'bench.ipc'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function registerBenchIpc(): void {
  ipcMain.handle(IPC.BENCH_LIST, async (_e, { repoPath }: { repoPath: string }) => {
    const workspaces = listWorkspaces(repoPath)
    // The source tip lets the UI say how far the bench base has drifted from
    // the feature branch without a second round trip.
    const tips: Record<string, string> = {}
    for (const ws of workspaces) {
      tips[ws.sourceBranch] = await sourceBranchTip(repoPath, ws.sourceBranch)
    }
    return { workspaces, tips }
  })

  ipcMain.handle(IPC.BENCH_ENSURE, async (_e, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
    log('ensure workspace', { repo_path: repoPath, source_branch: sourceBranch })
    return { workspace: ensureWorkspace(repoPath, sourceBranch) }
  })

  ipcMain.handle(
    IPC.BENCH_ADD_MEMBER,
    async (_e, { repoPath, sourceBranch, worktreePath, branchName }:
      { repoPath: string; sourceBranch: string; worktreePath: string; branchName: string }) => {
      const result = await addMember(repoPath, sourceBranch, worktreePath, branchName)
      if (!result.ok) warn('add member refused', { branch: branchName, error: result.error ?? '' })
      return result
    },
  )

  ipcMain.handle(
    IPC.BENCH_REMOVE_MEMBER,
    async (_e, { repoPath, sourceBranch, worktreePath }:
      { repoPath: string; sourceBranch: string; worktreePath: string }) => {
      log('remove member', { worktree_path: worktreePath })
      return { workspace: removeMember(repoPath, sourceBranch, worktreePath) }
    },
  )

  ipcMain.handle(
    IPC.BENCH_SET_ENABLED,
    async (_e, { repoPath, sourceBranch, worktreePath, enabled }:
      { repoPath: string; sourceBranch: string; worktreePath: string; enabled: boolean }) => {
      return { workspace: setMemberEnabled(repoPath, sourceBranch, worktreePath, enabled) }
    },
  )

  ipcMain.handle(
    IPC.BENCH_SET_REVIEW,
    async (_e, { repoPath, sourceBranch, worktreePath, review }:
      { repoPath: string; sourceBranch: string; worktreePath: string; review: 'good' | 'issue' | null }) => {
      return { workspace: setMemberReview(repoPath, sourceBranch, worktreePath, review) }
    },
  )

  ipcMain.handle(
    IPC.BENCH_SET_ORDER,
    async (_e, { repoPath, sourceBranch, worktreePath, toIndex }:
      { repoPath: string; sourceBranch: string; worktreePath: string; toIndex: number }) => {
      return { workspace: setMemberOrder(repoPath, sourceBranch, worktreePath, toIndex) }
    },
  )

  ipcMain.handle(
    IPC.BENCH_UPDATE_MEMBER,
    async (_e, { repoPath, sourceBranch, worktreePath }:
      { repoPath: string; sourceBranch: string; worktreePath: string }) => {
      log('update member', { worktree_path: worktreePath, source_branch: sourceBranch })
      const result = await updateMember(repoPath, sourceBranch, worktreePath)
      if (!result.ok) warn('update member failed', { worktree_path: worktreePath, error: result.error ?? '' })
      return result
    },
  )

  ipcMain.handle(
    IPC.BENCH_UPDATE_ALL,
    async (_e, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
      log('update all stale', { source_branch: sourceBranch })
      const result = await updateAllStale(repoPath, sourceBranch)
      if (!result.ok) warn('update all failed', { source_branch: sourceBranch, error: result.error ?? '' })
      return result
    },
  )

  ipcMain.handle(
    IPC.BENCH_ASSEMBLE,
    async (_e, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
      log('assemble', { source_branch: sourceBranch })
      const result = await assembleWorkspace(repoPath, sourceBranch)
      if (!result.ok) warn('assemble failed', { source_branch: sourceBranch, error: result.error ?? '' })
      else {
        log('assemble ok', {
          source_branch: sourceBranch,
          outcome: result.workspace?.lastAssembly ?? 'unknown',
          retired: (result.retired ?? []).length,
          members: result.workspace?.members.length ?? 0,
        })
      }
      return result
    },
  )

  ipcMain.handle(
    IPC.BENCH_RESOLVE_CONFLICT,
    async (_e, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
      log('resolve conflict requested', { source_branch: sourceBranch })
      const result = await prepareConflictResolution(repoPath, sourceBranch)
      if (!result.ok) warn('resolve conflict preparation failed', { source_branch: sourceBranch, error: result.error ?? '' })
      return result
    },
  )

  ipcMain.handle(
    IPC.BENCH_REFRESH_STALENESS,
    async (_e, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
      return { workspace: await refreshStaleness(repoPath, sourceBranch) }
    },
  )
}
