/**
 * permission-clear — the single predicate for "this status transition
 * implies no permission can still be pending". Shared by the main-process
 * ATV cache and renderer stores so every surface clears queues on the same
 * truth (mirror-store architecture: one implementation, no drift).
 *
 * Mirrors the semantics of the renderer's terminal-status queue clearing
 * (event-slice) and the ATV canvas bubble clear (mapping.ts): a run that is
 * actively running again, or has reached a terminal state, cannot be
 * blocked on a permission answer.
 */
export function permissionClearingState(state: string): boolean {
  switch (state) {
    case 'running':
    case 'idle':
    case 'completed':
    case 'done':
    case 'failed':
    case 'dead':
    case 'error':
      return true
    default:
      return false
  }
}
