/**
 * Plan-mode implementation callbacks for the unified ConversationView.
 *
 * Extracted from ConversationView.tsx (formerly EngineView.tsx) to keep that file under the 600-line cap.
 * These callbacks handle the ExitPlanMode / "Implement" flow for engine tabs:
 * switching the instance to auto mode, inserting the divider, auto-moving
 * the tab to the in-progress group, and submitting the implementation prompt.
 */

import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { formatImplementDivider, planSlugFromPath } from '../../shared/clear-divider'
import { commitInstance } from '../stores/conversation-instance'

/** Shape of the denial entry for extracting planFilePath from toolInput. */
interface DenialEntry {
  tools: Array<{ toolName: string; toolInput?: Record<string, unknown> }>
}

/** Deps threaded in from the conversation view so the helpers share the component's closure values. */
export interface ImplementDeps {
  tabId: string
  clearPermissionDenied: () => void
  submit: (tabId: string, text: string, opts?: { implementationPhase?: boolean }) => void
  tabPlanFilePath: string | null | undefined
  permissionDenied: DenialEntry | null
}

/**
 * Build the `handleImplement` callback for the unified ConversationView.
 * Called inside `useCallback` with the dep array in EngineView.
 */
export async function runHandleImplement(
  deps: ImplementDeps,
  clearContext: boolean,
): Promise<void> {
  const { tabId, clearPermissionDenied, submit, tabPlanFilePath, permissionDenied } = deps

  console.log(`[EngineView] handleImplement: tab=${tabId.slice(0, 8)} clearContext=${clearContext}`)
  clearPermissionDenied()

  // Set tab to running immediately to close the race window between
  // clearing the denial card and submitting the implement prompt.
  // Without this, heartbeat ticks during the async plan read can
  // re-promote stale denials (see engine_status handler in event-slice.ts).
  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const } : t),
  }))

  // Insert an "Implementing plan" divider so the user can see the
  // boundary between planning and implementation phases — mirrors the
  // CLI tab path in usePermissionDeniedHandlers.ts. Resolve the plan file
  // path first (from the tab-level field, falling back to the ExitPlanMode
  // denial's toolInput) so the divider carries the slug + path and the
  // renderer can make the slug a clickable link to the plan preview — the
  // same treatment as the plan-created / plan-updated dividers.
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
  useSessionStore.getState().addEngineSystemMessage(
    tabId,
    formatImplementDivider(new Date(), planSlugFromPath(planFilePath)),
    planFilePath || undefined,
  )

  // Flip the AUTHORITATIVE permission mode to 'auto' for this tab. The
  // permission mode lives in different places per tab type — on the active
  // conversation instance for engine tabs, on the parent `tab.permissionMode`
  // for plain/CLI tabs (see effectivePermissionMode in conversation-instance.ts).
  // The shared `setPermissionMode` store action resolves that split: it writes
  // the correct location AND routes the engine plan-mode flip (engineSetPlanMode
  // for engine tabs, setPermissionMode→set_plan_mode(false) for plain tabs).
  //
  // Writing only the instance here (the previous behavior) left a plain tab's
  // parent `tab.permissionMode` stuck on 'plan'. The very next `submit()` then
  // re-read that stale parent via effectivePermissionMode and re-asserted plan
  // mode through the prompt_sync path (window.ion.setPermissionMode in
  // send-slice.ts), flipping the engine back into plan mode milliseconds after
  // we turned it off — so the implement run executed in plan mode. Routing
  // through the store action fixes both tab types and removes the divergence
  // from the iOS implement path (usePermissionDeniedHandlers.onImplement), which
  // already uses setPermissionMode('auto', 'plan_approved').
  //
  // setPermissionMode operates on the store's activeTabId. The Implement button
  // only renders on the active conversation's permission-denied card, so the
  // implement tab IS the active tab. Guard + log that assumption so a non-active
  // edge case is observable instead of a silent no-op; fall back to the
  // instance write only if the assumption is ever violated.
  const activeTabId = useSessionStore.getState().activeTabId
  if (activeTabId === tabId) {
    useSessionStore.getState().setPermissionMode('auto', 'plan_approved')
  } else {
    console.warn(`[EngineView] handleImplement: implement tab=${tabId.slice(0, 8)} is not active (active=${activeTabId?.slice(0, 8) ?? 'none'}); falling back to instance-only plan-mode flip`)
    useSessionStore.setState((s) => ({
      conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
        ...inst,
        permissionMode: 'auto',
      })),
    }))
    window.ion.engineSetPlanMode(tabId, false)
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

  // Read plan content (planFilePath was resolved above for the divider).
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
  console.log(`[ConversationView] submitting implement prompt: tab=${tabId.slice(0, 8)} promptLen=${implementPrompt.length}`)
  submit(tabId, implementPrompt, { implementationPhase: true })
}
