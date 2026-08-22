import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { rError, rInfo } from '../rendererLogger'

/**
 * Worktree renderer listeners kept outside App so app composition stays within
 * the file-size cap. These broadcasts update both overlay and Studio through the
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

  // The main-process freshness poll is the ONLY thing that keeps worktree rows
  // current during a working session. Nothing else re-reads git: the Inbox's
  // own refresh effect is keyed on the set of projects, which does not change
  // while the operator works, so without this a row's dirty marker, unlanded
  // count, and bench pin verdict freeze at whatever they were when the Inbox
  // first mounted.
  //
  // `refreshWorkspaceViews` is safe to call on every tick because both halves
  // compare structurally and keep the previous store reference when git has not
  // moved — that is what stops a 5-second timer from becoming a 5-second
  // re-render of every worktree surface.
  useEffect(() => {
    return window.ion.onWorktreeFreshnessTick(({ repoPaths }) => {
      const refresh = useSessionStore.getState().refreshWorkspaceViews
      for (const repoPath of repoPaths) {
        void refresh(repoPath).catch((err) => rError('worktree', 'freshness refresh failed', {
          repo_path: repoPath,
          error: String(err),
        }))
      }
    })
  }, [])
}
