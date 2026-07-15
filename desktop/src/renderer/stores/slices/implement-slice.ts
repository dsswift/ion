/**
 * implement-slice — the ONE plan-approval → implementation pipeline.
 *
 * `implementPlan(tabId, opts)` is a STORE ACTION (not component logic) so
 * every surface runs the identical pipeline in the OWNER window:
 *   - Overlay: ConversationView's Implement buttons call it directly.
 *   - ATV shell: the mirror forwards it (FORWARDED_ACTIONS) — one IPC hop,
 *     then the owner executes every step against owner state. The mirror
 *     never runs business logic. Before this action existed, the flow lived
 *     in a component helper that executed in whichever window hosted the
 *     card: in the ATV that meant a mix of forwarded and mirror-local calls
 *     (unpin forwarded but the pin check read stale mirror state → the
 *     in-progress auto-move was suppressed; the mode flip ran against the
 *     owner's ACTIVE tab, not the card's tab; the divider landed only in the
 *     mirror transcript).
 *
 * Every step is keyed by the EXPLICIT tabId — no activeTabId assumptions.
 * The iOS path (main/remote/handlers/implement-plan.ts) still mirrors these
 * steps through its main-process transport; behavior changes here must be
 * reflected there until that handler delegates to this action.
 */
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { formatImplementDivider, planSlugFromPath } from '../../../shared/clear-divider'
import { commitInstance, activeInstance } from '../conversation-instance'
import { applyPermissionModeForTab } from './tab-slice-permission-mode'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

export function createImplementSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    implementPlan: async (tabId, opts = {}) => {
      const { clearContext = false, unpin = false } = opts
      const tab0 = get().tabs.find((t) => t.id === tabId)
      if (!tab0) {
        rWarn('implement', 'implementPlan: unknown tab', { tab_id: tabId.slice(0, 8) })
        return
      }
      rInfo('implement', 'implementPlan', { tab_id: tabId.slice(0, 8), clear_context: clearContext, unpin })

      // Capture the denial BEFORE clearing it — the ExitPlanMode entry is a
      // planFilePath fallback source below.
      const inst0 = activeInstance(get().conversationPanes, tabId)
      const permissionDenied = inst0?.permissionDenied ?? null

      // "Implement and Unpin": release the group pin FIRST, synchronously in
      // this (owner) store, so the auto-move pin check below reads the fresh
      // state. Ordering by construction — no cross-window race.
      if (unpin && tab0.groupPinned) {
        get().toggleTabGroupPin(tabId)
      }

      // Dismiss the Plan Ready card on this tab's active instance.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          permissionDenied: null,
        })),
      }))

      // Set tab to running immediately to close the race window between
      // clearing the denial card and submitting the implement prompt.
      // Without this, heartbeat ticks during the async plan read can
      // re-promote stale denials (see engine_status handler in event-slice.ts).
      set((s) => ({
        tabs: s.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const } : t),
      }))

      // Insert an "Implementing plan" divider so the user can see the
      // boundary between planning and implementation phases. Resolve the plan
      // file path first (from the instance field, falling back to the
      // ExitPlanMode denial's toolInput) so the divider carries the slug +
      // path and the renderer can make the slug a clickable link to the plan
      // preview — the same treatment as the plan-created / plan-updated dividers.
      let planFilePath: string | null = inst0?.planFilePath || null
      if (!planFilePath && permissionDenied?.tools) {
        const exitDenial = permissionDenied.tools.find(
          (t) => t.toolName === 'ExitPlanMode' && t.toolInput,
        )
        if (exitDenial?.toolInput?.planFilePath) {
          planFilePath = exitDenial.toolInput.planFilePath as string
        }
      }
      get().addEngineSystemMessage(
        tabId,
        formatImplementDivider(new Date(), planSlugFromPath(planFilePath)),
        planFilePath || undefined,
      )

      // clearContext branch: destroy the engine session so the implementation run
      // starts clean. This clears the conversation, the plan-mode system prompt,
      // and the restricted tool list. The prior conversation ID is archived into
      // historicalSessionIds so the user can still navigate back to it, and is
      // recorded as the parent of the next session so the engine writes the
      // correct on-disk parentId linkage. The active instance is tagged
      // pendingCutReason: 'clear' so the session ledger records the cut reason.
      //
      // Note: the implement divider was already inserted above (addEngineSystemMessage),
      // so this branch only performs the session reset + archive bookkeeping.
      if (clearContext) {
        rInfo('implement', 'clearing context', { tab_id: tabId.slice(0, 8) })
        window.ion.resetTabSession(tabId)
        set((s) => {
          const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
            ...inst,
            // Consumed once by the session_init append site to tag the next minted id.
            pendingCutReason: 'clear' as const,
            permissionQueue: [],
            permissionDenied: null,
          }))
          return {
            conversationPanes,
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    historicalSessionIds: [
                      ...t.historicalSessionIds,
                      ...(t.conversationId && !t.historicalSessionIds.includes(t.conversationId)
                        ? [t.conversationId] : []),
                    ],
                    // Parent of the next conversation, so the engine writes it as the
                    // new conversation's on-disk parentId. Consumed once at next start.
                    pendingParentConversationId: t.conversationId,
                    conversationId: null,
                    lastResult: null,
                    currentActivity: '',
                    queuedPrompts: [],
                  }
                : t
            ),
          }
        })
      }

      // Flip the AUTHORITATIVE permission mode to 'auto' for THIS tab. The
      // shared per-tab core (tab-slice-permission-mode.ts) writes the active
      // instance AND routes the engine plan-mode flip (engineSetPlanMode for
      // extension-hosted tabs, setPermissionMode → set_plan_mode(false) for
      // plain tabs). Explicit tabId: no "the implement tab is the active tab"
      // assumption — a forwarded ATV call executes here with the card's tab.
      applyPermissionModeForTab(set, get, tabId, 'auto', 'plan_approved')

      // Auto-switch to the implementation model if the split feature is enabled
      const { planModelSplitEnabled, implementModeModel } = usePreferencesStore.getState()
      if (planModelSplitEnabled && implementModeModel) {
        get().setTabModel(tabId, implementModeModel)
      }

      // Auto-move tab to in-progress group if designated
      const { inProgressGroupId, tabGroupMode, autoGroupMovement } = usePreferencesStore.getState()
      const tab = get().tabs.find((t) => t.id === tabId)
      if (autoGroupMovement && inProgressGroupId && tabGroupMode === 'manual' && tab && tab.groupId !== inProgressGroupId) {
        if (tab.groupPinned) {
          rDebug('implement.auto-move', 'suppressed: tab pinned', { tab_id: tabId.slice(0, 8) })
        } else {
          get().moveTabToGroup(tabId, inProgressGroupId)
        }
      }

      // Read plan content (planFilePath was resolved above for the divider).
      let planContent: string | null = null
      if (planFilePath) {
        try {
          const result = await window.ion.readPlan(planFilePath)
          planContent = result.content
        } catch (err) {
          rWarn('implement', 'failed to read plan file', { path: planFilePath, error: String(err) })
        }
      }

      // Clear the instance-level planFilePath now that we've consumed it.
      // The authoritative field is conversationPanes → instance.planFilePath
      // (mirrors the iOS precedent in handlers/implement-plan.ts).
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          planFilePath: null,
        })),
      }))

      const implementPrompt = planContent
        ? `Implement the following plan:\n\n${planContent}`
        : 'Implement the plan.'
      rInfo('implement', 'submitting implement prompt', { tab_id: tabId.slice(0, 8), prompt_len: implementPrompt.length })
      get().submit(tabId, implementPrompt, { implementationPhase: true })
    },
  }
}
