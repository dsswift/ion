import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import type { StatusFields } from '../../shared/types'
import { tabHasExtensions } from '../../shared/tab-predicates'
import { effectiveRunningChildrenCount } from './TabStripShared'

/**
 * Resolve the currently-active engine instance's `StatusFields` snapshot.
 *
 * Engine status is carried on the instance object in `conversationPanes`, on
 * `instance.statusFields`. The engine-only StatusBar display slots (extension
 * name, engine cost, "via CLI" backend badge) read from this same source —
 * this helper centralizes the selector. These slots are legitimately engine-
 * only: a plain conversation has no extension identity / engine cost to show,
 * so `null` here is absence of data, not a tab-type behavior fork.
 *
 * Returns `null` when the active tab hosts no extensions or has no active
 * instance. Callers gate their rendering on the returned fields.
 *
 * Uses `useShallow` so consumers only re-render when the relevant
 * fields change, not on every unrelated session-store write.
 */
export function useActiveEngineStatusFields(): StatusFields | null {
  return useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab || !tabHasExtensions(tab)) return null
      const pane = s.conversationPanes.get(s.activeTabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return null
      const inst = pane.instances.find((i) => i.id === instanceId)
      return inst?.statusFields ?? null
    }),
  )
}

/**
 * Number of dispatched agents currently in the `running`
 * state for the active conversation instance. Used by the engine state slot
 * to render the yellow "waiting for N agent(s)" pulse when
 * the orchestrator itself is idle but child agents are still working.
 *
 * TAB-TYPE-AGNOSTIC: the `Agent` tool dispatches sub-agents
 * regardless of whether a harness is loaded, so a plain conversation can have
 * running children too. Uses `effectiveRunningChildrenCount` (imported from
 * TabStripShared.ts) — the canonical helper that folds both `inst.agentStates`
 * and `inst.statusFields.backgroundAgents` via max, so the "awaiting children"
 * pulse fires for plain tabs dispatching background agents as well — consistent
 * with the close guard that now blocks closing any tab with running children.
 *
 * Returns 0 when there is no active instance or no running children.
 */
export function useActiveEngineAgentRunningCount(): number {
  return useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return 0
    const pane = s.conversationPanes.get(s.activeTabId)
    const instanceId = pane?.activeInstanceId
    if (!instanceId) return 0
    const inst = pane.instances.find((i: any) => i.id === instanceId)
    if (!inst) return 0
    return effectiveRunningChildrenCount(inst)
  })
}

/**
 * Number of background bash commands the ACTIVE tab's active instance is
 * waiting on (Bash run_in_background + notify_on_complete).
 *
 * The shell counterpart to `useActiveEngineAgentRunningCount`. Drives the
 * status-bar "waiting for N background shell(s)" slot when the orchestrator
 * itself is idle but shell work is still in flight.
 *
 * Counts only notifying commands — a fire-and-forget `run_in_background`
 * command is not something the session is holding for, so it does not appear
 * here.
 *
 * Returns 0 when there is no active instance or no outstanding commands.
 */
export function useActiveEngineBackgroundShellCount(): number {
  return useSessionStore((s) => {
    const pane = s.conversationPanes.get(s.activeTabId)
    const instanceId = pane?.activeInstanceId
    if (!instanceId) return 0
    const inst = pane.instances.find((i: { id: string }) => i.id === instanceId)
    if (!inst) return 0
    return inst.statusFields?.backgroundShells ?? 0
  })
}
