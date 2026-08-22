/**
 * TabStripActivityFolds — per-tab "is work in flight?" fold helpers.
 *
 * Extracted from TabStripShared.ts at the file-size cap. These four helpers
 * form one cohesive cluster: each folds across a tab's `conversationPanes`
 * instances to answer a single question about in-flight work, and together
 * they feed the `getTabStatusColor` cascade, the status-bar indicators, and
 * the tab close guards.
 *
 *   isAnyEngineInstanceRunning        — foreground orchestrator activity
 *   isAnyEngineInstanceStarting       — engine attachment in progress
 *   effectiveRunningChildrenCount     — dispatched background agents (per instance)
 *   anyEngineInstanceHasRunningChildren — dispatched background agents (per tab)
 *   engineInstanceBackgroundShellCount / anyEngineInstanceHasRunningShells
 *                                     — background bash commands
 *
 * All of them read `useSessionStore.getState()` and are therefore NOT reactive
 * on their own: React callers must subscribe to `conversationPanes` (and, for
 * the agent folds, `engineAgentStates`) so the component re-renders when the
 * underlying state moves. TabStripShared.ts re-exports the whole cluster, so
 * existing import sites are unchanged.
 */

import { useSessionStore } from '../stores/sessionStore'
import type { StatusFields } from '../../shared/types-engine'

export function isAnyEngineInstanceRunning(tabId: string): boolean {
  const s = useSessionStore.getState()
  const pane = s.conversationPanes.get(tabId)
  if (!pane || pane.instances.length === 0) return false
  for (const inst of pane.instances) {
    const state = inst.statusFields?.state
    if (state === 'running' || state === 'connecting') return true
  }
  return false
}

/** True when an engine has attached the session but has not started a run. */
export function isAnyEngineInstanceStarting(tabId: string): boolean {
  const s = useSessionStore.getState()
  const pane = s.conversationPanes.get(tabId)
  if (!pane || pane.instances.length === 0) return false
  return pane.instances.some((inst) => inst.statusFields?.state === 'starting')
}

/**
 * Canonical running-children count for a single conversation instance.
 *
 * Two data sources can report running background agents for the same
 * instance — we take the MAX, not the sum, because both vantage points
 * observe the same underlying agents:
 *
 *   • `inst.agentStates` — per-agent entries emitted by the engine for
 *     extension-hosted (orchestrator) conversations.
 *   • `inst.statusFields.backgroundAgents` — a scalar count the engine
 *     emits for plain-conversation dispatches where individual agent
 *     states are not surfaced via `agentStates`.
 *
 * Taking the max prevents double-counting when both fields are populated
 * simultaneously while still catching the backgroundAgents-only case
 * (plain conversations) that the agentStates-only fold missed.
 *
 * TAB-TYPE-AGNOSTIC: a plain conversation with background agents
 * qualifies too. The fix makes the "awaiting children" aspirational
 * comments in this file true in practice.
 */
export function effectiveRunningChildrenCount(inst: {
  agentStates: ReadonlyArray<{ status: string }>
  statusFields?: Pick<StatusFields, 'backgroundAgents' | 'backgroundShells' | 'hasPendingWork'> | null
}): number {
  let fromAgentStates = 0
  for (const a of inst.agentStates) {
    if (a.status === 'running') fromAgentStates++
  }
  const fromBackgroundAgents = inst.statusFields?.backgroundAgents ?? 0
  return Math.max(fromAgentStates, fromBackgroundAgents)
}

/**
 * Check whether any engine instance under a tab has running dispatched
 * background agents. Sibling to `isAnyEngineInstanceRunning` — folds
 * across `conversationPanes` instances and reads per-instance entries from
 * both `inst.agentStates` and `inst.statusFields.backgroundAgents` via
 * the canonical `effectiveRunningChildrenCount` helper.
 *
 * This is the data source for the "awaiting children" yellow pulsing dot
 * on the parent tab pill and for the action-layer guard in `closeTab`
 * that hard-blocks tab close while background agents are still executing.
 *
 * TAB-TYPE-AGNOSTIC: a plain conversation with background agents qualifies
 * too — `inst.statusFields.backgroundAgents` carries the count for plain
 * dispatches where `inst.agentStates` remains empty.
 *
 * NOTE: Reads from `useSessionStore.getState()` — not reactive on its
 * own. Callers in React components must subscribe to
 * `engineAgentStates` so the component re-renders when child agents
 * start or finish (e.g. via `useSessionStore((s) => s.engineAgentStates)`).
 */
export function anyEngineInstanceHasRunningChildren(tabId: string): boolean {
  const s = useSessionStore.getState()
  const pane = s.conversationPanes.get(tabId)
  if (!pane || pane.instances.length === 0) return false
  for (const inst of pane.instances) {
    if (effectiveRunningChildrenCount(inst) > 0) return true
  }
  return false
}

export function isAnyTerminalCommandRunning(tabId: string): boolean {
  return useSessionStore.getState().terminalActiveTabIds.has(tabId)
}

/**
 * Total background shell commands a tab is waiting on, summed across its
 * engine instances.
 * helper there is only ONE data source (`statusFields.backgroundShells`), so
 * this sums across instances rather than taking a max: two instances running
 * background commands are waiting on genuinely different processes, whereas
 * the two agent sources observe the same agents.
 *
 * Counts only commands started with `notify_on_complete` — those are the ones
 * the engine holds the session open for. A fire-and-forget
 * `run_in_background` command is not something the tab is waiting on, so it
 * does not light the status dot.
 *
 * NOTE: Reads from `useSessionStore.getState()` — not reactive on its own.
 * Callers in React components must subscribe to `conversationPanes` so the
 * component re-renders when the count changes.
 */
export function engineInstanceBackgroundShellCount(tabId: string): number {
  const s = useSessionStore.getState()
  const pane = s.conversationPanes.get(tabId)
  if (!pane || pane.instances.length === 0) return 0
  let total = 0
  for (const inst of pane.instances) {
    total += inst.statusFields?.backgroundShells ?? 0
  }
  return total
}

/**
 * Whether any engine instance under a tab is waiting on background shell
 * commands. Sibling to `anyEngineInstanceHasRunningChildren`; drives the pink
 * shell dot and the close guard.
 */
export function anyEngineInstanceHasRunningShells(tabId: string): boolean {
  return engineInstanceBackgroundShellCount(tabId) > 0
}

/**
 * Returns true when an engine status snapshot says accepted work remains even
 * though no foreground run or visible child/shell count is present yet. This
 * exact engine verdict closes the delivery-window gap between a terminal child
 * and the root wake that will consume its result.
 */
export function anyEngineInstanceHasPendingWork(tabId: string): boolean {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  if (!pane) return false
  return pane.instances.some((inst) => inst.statusFields?.hasPendingWork === true)
}

