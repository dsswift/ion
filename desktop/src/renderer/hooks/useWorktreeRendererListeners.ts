import { useEffect } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rError, rInfo } from '../rendererLogger'
import { host } from '../host/host-instance'
import { withTargetEnvironment } from '../studio/connection/tab-environment'

/**
 * Worktree announcements from every connected Environment, answered on the
 * Environment that made them.
 *
 * Each payload names paths on the announcing server's disk. A forwarded store
 * action that names no tab goes to the local server, so every re-read here is
 * pinned to the announcing Environment with `withTargetEnvironment`: a remote
 * worktree's rows are refreshed on the machine that has the worktree.
 *
 * Routine freshness is not here. Each server's own freshness poll refreshes
 * its store; these listeners only shorten the wait after a title or a land.
 */
export function useWorktreeRendererListeners(): void {
  useEffect(() => {
    return host.shell.onWorktreeTitled(({ repoPath, worktreePath, title }, environmentId) => {
      rInfo('worktree', 'worktree titled', { repo_path: repoPath, worktree_path: worktreePath, title, environment_id: environmentId })
      if (!repoPath) return
      void withTargetEnvironment(environmentId, () => useSessionStore.getState().refreshWorktreeInventory(repoPath))
        .catch((err) => rError('worktree', 'inventory refresh after titling failed', { error: String(err), environment_id: environmentId }))
    })
  }, [])

  useEffect(() => {
    return host.shell.onWorktreeLanded(({ repoPath, worktreePath }, environmentId) => {
      void withTargetEnvironment(environmentId, () => useSessionStore.getState().sealLandedWorktree(worktreePath))
        .then(() => withTargetEnvironment(environmentId, () => useSessionStore.getState().refreshWorkspaceViews(repoPath)))
        .catch((err) => rError('worktree', 'landed-worktree seal failed', {
          worktree_path: worktreePath,
          environment_id: environmentId,
          error: String(err),
        }))
    })
  }, [])
}
