import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import type { StatusFields } from '../../shared/types'

/**
 * Resolve the currently-active engine instance's `StatusFields` snapshot.
 *
 * Engine status is carried on the instance object in `conversationPanes`, on
 * `instance.statusFields`. Every engine-only StatusBar slot (state dot,
 * extension name, model picker engine variant, context bar, cost, "via CLI"
 * badge per-instance) reads from this same source — this helper centralizes
 * the selector so the slots don't each duplicate the active-tab +
 * active-instance lookup.
 *
 * Returns `null` when the active tab is not an engine tab or has no
 * active instance. Callers gate their rendering on `isEngine && fields`.
 *
 * Uses `useShallow` so consumers only re-render when the relevant
 * fields change, not on every unrelated session-store write.
 */
export function useActiveEngineStatusFields(): StatusFields | null {
  return useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab?.hasEngineExtension) return null
      const pane = s.conversationPanes.get(s.activeTabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return null
      const inst = pane.instances.find((i) => i.id === instanceId)
      return inst?.statusFields ?? null
    }),
  )
}

/**
 * Compound key `${tabId}:${activeInstanceId}` for the current engine
 * tab+instance. Used by slots that need to read/write per-instance
 * maps like `engineModelOverrides`, `enginePermissionModes`,
 * `engineAgentStates`, etc.
 *
 * Returns `null` when the active tab is not an engine tab or has no
 * active instance.
 */
export function useActiveEngineKey(): { tabId: string; instanceId: string; key: string } | null {
  return useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab?.hasEngineExtension) return null
      const pane = s.conversationPanes.get(s.activeTabId)
      const instanceId = pane?.activeInstanceId
      if (!instanceId) return null
      return { tabId: s.activeTabId, instanceId, key: `${s.activeTabId}:${instanceId}` }
    }),
  )
}

/**
 * Number of dispatched background agents currently in the `running`
 * state for the active engine instance. Used by the engine state slot
 * to render the yellow "waiting for N background agent(s)" pulse when
 * the orchestrator itself is idle but child agents are still working.
 *
 * Returns 0 when the active tab is not an engine tab or has no
 * running children.
 */
export function useActiveEngineAgentRunningCount(): number {
  return useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab?.hasEngineExtension) return 0
    const pane = s.conversationPanes.get(s.activeTabId)
    const instanceId = pane?.activeInstanceId
    if (!instanceId) return 0
    const inst = pane.instances.find((i) => i.id === instanceId)
    if (!inst) return 0
    let count = 0
    for (const a of inst.agentStates) if (a.status === 'running') count++
    return count
  })
}
