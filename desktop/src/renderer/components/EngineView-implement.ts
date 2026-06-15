/**
 * Plan-mode implementation callbacks for EngineView.
 *
 * Extracted from EngineView.tsx to keep that file under the 600-line cap.
 * These callbacks handle the ExitPlanMode / "Implement" flow for engine tabs:
 * switching the instance to auto mode, inserting the divider, auto-moving
 * the tab to the in-progress group, and submitting the implementation prompt.
 */

import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { formatImplementDivider } from '../../shared/clear-divider'
import { parseSessionKey } from '../../shared/session-key'

/** Shape of the denial entry for extracting planFilePath from toolInput. */
interface DenialEntry {
  tools: Array<{ toolName: string; toolInput?: Record<string, unknown> }>
}

/** Deps threaded in from EngineView so the helpers share the component's closure values. */
export interface ImplementDeps {
  tabId: string
  key: string
  clearPermissionDenied: () => void
  submitEnginePrompt: (...args: any[]) => void
  tabPlanFilePath: string | null | undefined
  permissionDenied: DenialEntry | null
}

/**
 * Build the `handleImplement` callback for EngineView.
 * Called inside `useCallback` with the dep array in EngineView.
 */
export async function runHandleImplement(
  deps: ImplementDeps,
  clearContext: boolean,
): Promise<void> {
  const { tabId, key, clearPermissionDenied, submitEnginePrompt, tabPlanFilePath, permissionDenied } = deps

  console.log(`[EngineView] handleImplement: tab=${tabId.slice(0, 8)} key=${key} clearContext=${clearContext}`)
  clearPermissionDenied()

  // Set tab to running immediately to close the race window between
  // clearing the denial card and submitting the implement prompt.
  // Without this, heartbeat ticks during the async plan read can
  // re-promote stale denials (see engine-event-status.ts suppression).
  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const } : t),
  }))

  // Insert an "Implementing plan" divider so the user can see the
  // boundary between planning and implementation phases — mirrors the
  // CLI tab path in usePermissionDeniedHandlers.ts.
  if (key) {
    useSessionStore.getState().addEngineSystemMessage(key, formatImplementDivider(new Date()))
  }

  // Switch to auto mode for this specific engine instance only.
  // Write permissionMode directly onto the instance in conversationPanes.
  if (key) {
    const { tabId: tabIdForKey, instanceId } = parseSessionKey(key)
    useSessionStore.setState((s) => {
      const conversationPanes = new Map(s.conversationPanes)
      const pane = conversationPanes.get(tabIdForKey)
      if (!pane) return {}
      const idx = pane.instances.findIndex((i) => i.id === instanceId)
      if (idx === -1) return {}
      const instances = pane.instances.slice()
      instances[idx] = { ...instances[idx], permissionMode: 'auto' }
      conversationPanes.set(tabIdForKey, { ...pane, instances })
      return { conversationPanes }
    })
    window.ion.engineSetPlanMode(key, false)
  }

  // Auto-switch to the implementation model if the split feature is enabled
  const { planModelSplitEnabled, implementModeModel } = usePreferencesStore.getState()
  if (planModelSplitEnabled && implementModeModel) {
    useSessionStore.getState().setTabModel(tabId, implementModeModel)
  }

  // Auto-move tab to in-progress group if designated
  const { inProgressGroupId, tabGroupMode, autoGroupMovement } = usePreferencesStore.getState()
  const tab = useSessionStore.getState().tabs.find(t => t.id === tabId)
  if (autoGroupMovement && inProgressGroupId && tabGroupMode === 'manual' && tab && tab.groupId !== inProgressGroupId) {
    if (tab.groupPinned) {
      console.log(`[EngineView] auto-move suppressed: tab=${tabId.slice(0, 8)} pinned=true`)
    } else {
      useSessionStore.getState().moveTabToGroup(tabId, inProgressGroupId)
    }
  }

  // Extract plan file path: tab state (engine event) > denial toolInput
  let planFilePath: string | null = tabPlanFilePath || null
  if (!planFilePath && permissionDenied?.tools) {
    const exitDenial = permissionDenied.tools.find(
      (t: { toolName: string; toolInput?: Record<string, unknown> }) =>
        t.toolName === 'ExitPlanMode' && t.toolInput
    )
    if (exitDenial?.toolInput?.planFilePath) {
      planFilePath = exitDenial.toolInput.planFilePath as string
    }
  }

  // Read plan content
  let planContent: string | null = null
  if (planFilePath) {
    try {
      const result = await window.ion.readPlan(planFilePath)
      planContent = result.content
    } catch (err) {
      console.warn('[EngineView] Failed to read plan file:', err)
    }
  }

  // Clear the tab-level planFilePath now that we've read it
  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId ? { ...t, planFilePath: null } : t
    ),
  }))

  const implementPrompt = planContent
    ? `Implement the following plan:\n\n${planContent}`
    : 'Implement the plan.'
  console.log(`[EngineView] submitting implement prompt: tab=${tabId.slice(0, 8)} promptLen=${implementPrompt.length}`)
  submitEnginePrompt(tabId, implementPrompt, undefined, undefined, undefined, true)
}
