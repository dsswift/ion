import type { RemoteWorktreeState } from '../protocol'

/// Replace one repository projection and remove stale checkout-alias entries.
/// A full snapshot must contain one worktree state per source repository.
export function replaceWorktreeState(
  states: Map<string, RemoteWorktreeState>,
  next: RemoteWorktreeState,
): void {
  for (const [key, cached] of states) {
    if (key !== next.repoPath && cached.repoPath === next.repoPath) {
      states.delete(key)
    }
  }
  states.set(next.repoPath, next)
}
