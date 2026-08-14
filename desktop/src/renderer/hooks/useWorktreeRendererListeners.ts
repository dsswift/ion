import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { rError, rInfo } from '../rendererLogger'

/**
 * Worktree renderer listeners kept outside App so app composition stays within
 * the file-size cap. These broadcasts update both overlay and ATV through the
 * shared owner store.
 */
export function useWorktreeRendererListeners(): void {
  useEffect(() => {
    return window.ion.onWorktreeTitled(({ repoPath, worktreePath, title }) => {
      rInfo('worktree', 'worktree titled', { repo_path: repoPath, worktree_path: worktreePath, title })
      if (!repoPath) return
      void useSessionStore.getState().refreshWorktreeInventory(repoPath)
        .catch((err) => rError('worktree', 'inventory refresh after titling failed', { error: String(err) }))
    })
  }, [])

  useEffect(() => {
    return window.ion.onWorktreeLanded(({ repoPath, worktreePath }) => {
      void useSessionStore.getState().sealLandedWorktree(worktreePath)
        .then(() => useSessionStore.getState().refreshWorkspaceViews(repoPath))
        .catch((err) => rError('worktree', 'landed-worktree seal failed', {
          worktree_path: worktreePath,
          error: String(err),
        }))
    })
  }, [])
}
