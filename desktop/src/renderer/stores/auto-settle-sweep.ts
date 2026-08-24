import type { StoreApi } from 'zustand'
import { effectiveSettled, type InboxTabView } from '../../shared/inbox-classify'
import { liveBackgroundShellCount } from '../../shared/background-shell-counts'
import { usePreferencesStore } from '../preferences'
import { activeInstance } from './conversation-instance'
import type { State } from './session-store-types'
import { rDebug, rError } from '../rendererLogger'
import { isPersistedSettled } from '../../shared/tab-predicates'
import { activeQuestionsCount } from './questions-store'

const AUTO_SETTLE_INTERVAL_MS = 60_000

function inboxView(state: State, tab: State['tabs'][number]): InboxTabView {
  const instance = activeInstance(state.conversationPanes, tab.id)
  // Active guided-question workflows block auto-settle like any pending ask.
  const pendingAskCount = (instance?.permissionQueue.length ?? 0) + (instance?.elicitationQueue.length ?? 0) + activeQuestionsCount(tab.id)
  const agentCount = instance?.agentStates.filter((agent) => agent.status === 'running').length ?? 0
  const backgroundAgents = instance?.statusFields?.backgroundAgents ?? 0
  const shells = liveBackgroundShellCount(instance?.statusFields)
  return {
    status: tab.status,
    settledOverride: tab.settledOverride,
    settledAt: tab.settledAt,
    snoozedUntil: tab.snoozedUntil,
    snoozedAt: tab.snoozedAt,
    lastVisitedAt: tab.lastVisitedAt,
    lastCompletionAt: tab.lastCompletionAt,
    lastMessageAt: tab.lastMessageAt,
    lastActivityAt: tab.lastActivityAt,
    manualUnread: tab.manualUnread,
    hasPendingPlan: instance?.planFilePath != null,
    hasPendingWork: Math.max(agentCount, backgroundAgents) > 0 || shells > 0 || instance?.statusFields?.hasPendingWork === true,
    pendingAskCount,
    waiting: instance?.permissionDenied != null,
    failed: tab.status === 'failed',
  }
}

/** Owner-only minute tick that turns a qualifying idle tab into hard settled history. */
export function startAutoSettleSweep(store: StoreApi<State>): () => void {
  const tick = (): void => {
    const days = usePreferencesStore.getState().inboxAutoSettleDays
    if (days <= 0) return
    const state = store.getState()
    const now = Date.now()
    for (const tab of state.tabs) {
      // A settled record opened for read-only review is temporarily spliced
      // into `state.tabs` (selectTab in tab-slice.ts) so the operator can look
      // at it, and it keeps its settled marker so returning to another tab
      // files it back into history unchanged. Without this guard the sweep
      // reads that same marker as "already settled, settle it again," restamps
      // it with `provenance: 'auto'` and today's date, and destroys the
      // original settle date/reason the moment the review sits open past one
      // tick. Reported: a 17-day-old manually-settled record was rewritten to
      // an auto-settle from today merely by being opened for review.
      if (isPersistedSettled(tab)) {
        rDebug('inbox', 'automatic settlement sweep skipped a tab already under settled review', { tab_id: tab.id.slice(0, 8) })
        continue
      }
      if (!effectiveSettled(inboxView(state, tab), now, days)) continue
      void state.autoSettleTab(tab.id).catch((error) => rError('inbox', 'automatic settlement failed', {
        tab_id: tab.id.slice(0, 8), error: String(error),
      }))
    }
  }
  const timer = setInterval(tick, AUTO_SETTLE_INTERVAL_MS)
  return () => clearInterval(timer)
}
