/**
 * tab-slice-permission-mode — the per-tab permission-mode flip, extracted
 * from tab-slice's `setPermissionMode` and parameterized by tabId.
 *
 * Two consumers:
 *   - `setPermissionMode(mode, source)` (tab-slice): the UI picker acting on
 *     the ACTIVE tab — delegates here with `get().activeTabId`.
 *   - `implementPlan(tabId, …)` (implement-slice): the plan-approval pipeline
 *     acting on an EXPLICIT tab. The old implement path called the
 *     active-tab-bound action and had to assume "the implement tab IS the
 *     active tab" — an assumption the ATV mirror (which forwards the call to
 *     the owner window, whose active tab can differ) broke in practice,
 *     flipping the mode on the wrong tab. Explicit tabId removes the
 *     assumption instead of guarding it.
 */
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet } from '../session-store-types'
import { applyActiveGroupMove } from './event-slice-running-move'

export function applyPermissionModeForTab(
  set: StoreSet,
  get: StoreGet,
  tabId: string,
  mode: 'auto' | 'plan',
  source?: string,
): void {
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab) return
  const pane = get().conversationPanes.get(tabId)
  const instanceId = pane?.activeInstanceId
  if (instanceId) {
    // All tab types: write permissionMode onto the active conversation instance.
    // Extension-hosted tabs call engineSetPlanMode to notify the extension host;
    // plain tabs call setPermissionMode so the engine CLI can react.
    set((s) => {
      const conversationPanes = new Map(s.conversationPanes)
      const paneInner = conversationPanes.get(tabId)
      if (!paneInner) return {}
      const idx = paneInner.instances.findIndex((i) => i.id === instanceId)
      if (idx === -1) return {}
      const instances = paneInner.instances.slice()
      instances[idx] = { ...instances[idx], permissionMode: mode }
      conversationPanes.set(tabId, { ...paneInner, instances })
      return { conversationPanes }
    })
    if (tab.engineProfileId) {
      // Pass the BARE tabId. After session-key unification (#256) the engine
      // keys sessions by the bare tabId (sessionKey() returns tabId; see
      // shared/session-key.ts), and SetPlanMode looks up m.sessions[key]
      // (engine/internal/session/plan_mode.go). The old compound
      // `${tabId}:${instanceId}` key missed the session map and silently
      // no-op'd, breaking plan-mode toggling on extension-hosted tabs. This
      // matches the sibling engine-call convention (implement-slice.ts,
      // useTabRestoration-engine.ts both pass the bare tabId).
      window.ion.engineSetPlanMode(tabId, mode === 'plan')
    } else {
      // When entering plan mode, forward the instance's persisted
      // planFilePath so the engine restores plan-file continuity if its
      // session was replaced (rebound) and lost the in-memory path.
      // Only meaningful on enter; on 'auto' the engine ignores it.
      const planFilePath = mode === 'plan'
        ? (pane?.instances.find((i) => i.id === instanceId)?.planFilePath ?? undefined)
        : undefined
      window.ion.setPermissionMode(tabId, mode, source, planFilePath || undefined)
    }
  }
  // Auto-switch to the plan model when entering plan mode
  const { planModelSplitEnabled, planModeModel } = usePreferencesStore.getState()
  if (planModelSplitEnabled && mode === 'plan' && planModeModel) {
    get().setTabModel(tabId, planModeModel)
  }

  // Re-evaluate the auto-group for a tab that is actively running/connecting:
  // flipping plan↔auto mid-run changes which group the tab belongs in
  // (planning vs in-progress), so move it there immediately rather than
  // waiting for the next send/running transition. The instance permissionMode
  // was just committed above, so `applyActiveGroupMove`'s authoritative
  // effectivePermissionMode read reflects the new mode. Its own guards
  // (autoGroupMovement, manual mode, not pinned, not already in target) decide
  // whether anything moves; an idle tab is left alone since the user has not
  // re-engaged it.
  if (tab.status === 'running' || tab.status === 'connecting') {
    const movedTab = get().tabs.find((t) => t.id === tabId)
    if (movedTab) {
      applyActiveGroupMove(tabId, movedTab, get().conversationPanes, get, 'permission_mode_change')
    }
  }
}
