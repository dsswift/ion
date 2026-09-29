import type { StoreApi } from 'zustand'
import { effectiveSettled } from '@ion/shared/inbox-classify'
import { usePreferencesStore } from '../persistence/preferences'
import { inboxTabView } from './inbox-tab-view'
import type { State } from './session-store-types'
import { rDebug, rError } from './rendererLogger'
import { isPersistedSettled } from '@ion/shared/tab-predicates'

const AUTO_SETTLE_INTERVAL_MS = 60_000

/**
 * The tabs a sweep at `days` would settle right now. One predicate for the
 * sweep and for the preview a client shows before auto-settle is turned on or
 * shortened (`inbox.previewAutoSettle`), so the number a person confirms is
 * the number the sweep then acts on.
 */
export function tabsAutoSettleWouldSettle(state: State, days: number, now: number): State['tabs'] {
  if (days <= 0) return []
  return state.tabs.filter((tab) => {
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
      rDebug('inbox', 'automatic settlement skipped a tab already under settled review', { tab_id: tab.id.slice(0, 8) })
      return false
    }
    return effectiveSettled(inboxTabView(state, tab), now, days)
  })
}

/** Owner-only minute tick that turns a qualifying idle tab into hard settled history. */
export function startAutoSettleSweep(store: StoreApi<State>): () => void {
  const tick = (): void => {
    // An Environment setting: one window for the whole server, whoever is
    // or is not connected.
    const days = usePreferencesStore.getState().inboxAutoSettleDays
    const state = store.getState()
    for (const tab of tabsAutoSettleWouldSettle(state, days, Date.now())) {
      void state.autoSettleTab(tab.id).catch((error) => rError('inbox', 'automatic settlement failed', {
        tab_id: tab.id.slice(0, 8), error: String(error),
      }))
    }
  }
  const timer = setInterval(tick, AUTO_SETTLE_INTERVAL_MS)
  return () => clearInterval(timer)
}
