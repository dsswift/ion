import type { ConversationPane } from '../../../shared/types-engine'

/**
 * True when a tab has engine-owned work that remains live after its foreground
 * orchestrator stops. The engine reports this as a snapshot field so this fold
 * also covers accepted wake and delivery work that has no visible agent row.
 */
export function hasPendingWorkInPane(pane: ConversationPane | undefined): boolean {
  if (!pane) return false
  for (const instance of pane.instances) {
    if (instance.statusFields?.hasPendingWork) return true
    if ((instance.statusFields?.backgroundAgents ?? 0) > 0) return true
    if ((instance.statusFields?.backgroundShells ?? 0) > 0) return true
    if (instance.agentStates.some((agent) => agent.status === 'running')) return true
  }
  return false
}
