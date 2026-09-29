/**
 * worktree/provision-start — start provisioning one worktree and publish
 * every state it passes through.
 *
 * Every path that puts a worktree on this host goes through here: a new
 * worktree, the operator's Re-provision, a worktree a transfer restored,
 * and the catch-up when a project is trusted. One entry point means none of
 * them can forget to record the state the inventory shows.
 */
import { provisionWorktree, type ProvisionOutcome } from './provision'
import { setProvisionState } from './provision-state'

export function startWorktreeProvisioning(repoPath: string, worktreePath: string): Promise<ProvisionOutcome> {
  setProvisionState(worktreePath, 'seeding')
  return provisionWorktree(repoPath, worktreePath, (state, detail) => {
    setProvisionState(worktreePath, state, detail)
  }).catch((err: unknown) => {
    // provisionWorktree never rejects by contract; this records it if it ever does.
    const error = String(err)
    setProvisionState(worktreePath, 'failed', error)
    return { state: 'failed' as const, results: [], error }
  })
}
