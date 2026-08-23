import type { ConversationPane } from '../../../shared/types-engine'
import { liveBackgroundShellCount } from '../../../shared/background-shell-counts'

/**
 * True when a tab has engine-owned work that remains live after its foreground
 * orchestrator stops. The engine reports `hasPendingWork` as a snapshot field
 * so this fold also covers accepted wake and delivery work that has no visible
 * agent row.
 *
 * The shell term reads the LIVE process count, not the engine's
 * `backgroundShells` scalar. `hasPendingWork` and `backgroundShells` both
 * count only commands the engine parks on (`notify_on_complete`), so a
 * detached `run_in_background` command left every one of this fold's consumers
 * — the Done-group auto-move, the auto-settle sweep, the inbox partition —
 * treating a tab with a live 96-second process as finished. See
 * `shared/background-shell-counts.ts`.
 */
export function hasPendingWorkInPane(pane: ConversationPane | undefined): boolean {
  if (!pane) return false
  for (const instance of pane.instances) {
    if (instance.statusFields?.hasPendingWork) return true
    if ((instance.statusFields?.backgroundAgents ?? 0) > 0) return true
    if (liveBackgroundShellCount(instance.statusFields) > 0) return true
    if (instance.agentStates.some((agent) => agent.status === 'running')) return true
  }
  return false
}
