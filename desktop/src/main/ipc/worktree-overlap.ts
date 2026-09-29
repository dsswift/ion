/**
 * IPC for the desktop-local Worktree Overlap visualizer: opening its window
 * and telling that window which repository it was opened for. The analysis,
 * solver and apply verbs behind the window are the server's
 * `worktree.overlap.*` actions (`server/src/protocol/worktree-overlap-actions.ts`),
 * which the window reaches over the Studio wire with the context it reads
 * here.
 */
import { ipcMain } from 'electron'
import { IPC } from '@ion/shared/types'
import { isValidProjectPath } from '@ion/server/ipc-validation'
import { openWorktreeOverlapWindow, worktreeOverlapContext } from '../worktree-overlap-window'
import { warn as _warn } from '../logger'

const TAG = 'worktree.overlap.ipc'
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function registerWorktreeOverlapIpc(): void {
  ipcMain.on(IPC.WORKTREE_OVERLAP_OPEN, (_event, input: unknown) => {
    const request = input as { repoPath?: unknown; sourceBranch?: unknown }
    if (typeof request?.repoPath !== 'string' || !isValidProjectPath(request.repoPath) || (request.sourceBranch !== undefined && typeof request.sourceBranch !== 'string')) {
      warn('open refused: invalid context')
      return
    }
    openWorktreeOverlapWindow({ repoPath: request.repoPath, sourceBranch: request.sourceBranch })
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_CONTEXT, (event) => worktreeOverlapContext(event.sender.id))
}
