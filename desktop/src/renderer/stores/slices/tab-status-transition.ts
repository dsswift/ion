/**
 * setTabStatus — the single canonical seam for tab status transitions.
 *
 * All renderer write sites that set tab.status on the tabs array route
 * through this helper. Centralizing the mutation makes the full set of valid
 * transitions auditable in one place and gives every writer a uniform guard
 * contract.
 *
 * ## Usage
 *
 * Without guard (unconditional):
 *   `tabs = setTabStatus(tabs, tabId, 'connecting')`
 *
 * With guard (conditional):
 *   `tabs = setTabStatus(tabs, tabId, 'idle', (t) => t.status === 'connecting')`
 *
 * ## Guards
 *
 * The guard predicate receives the current `TabState` and returns true only
 * when the transition should fire. Use guards for "only idle from connecting,
 * never from running" constraints so a late engine event can't knock a live
 * tab back to idle.
 *
 * ## What this does NOT cover
 *
 * The `ctx.updated.status = '...'` pattern in event-slice-task.ts operates on
 * a `TaskCtx.updated` mutation object (not the tabs array) and is handled by
 * the TaskCtx mutation system. Those writes stay in their own file.
 *
 * The `clearConnectingStatus` helper in prompt-pipeline-renderer.ts uses
 * `executeJavaScript` with an inline store mutation — it cannot import this
 * renderer helper across the main↔renderer process boundary. That is an
 * intentional cross-process constraint; the inline map there is the correct
 * approach.
 *
 * ## iOS parity
 *
 * iOS has 8 parallel write sites across 4 ViewModel files. A Swift equivalent
 * (`setTabStatus` in Swift) would mirror this pattern. The iOS writes currently
 * work correctly — this is latent-risk prevention for the desktop side.
 */

import type { TabState, TabStatus } from '../../../shared/types'

/**
 * Apply a tab status transition to the tabs array. Returns a new array when
 * the transition fires, or the SAME reference when the tab is not found, the
 * guard rejects the transition, or the tab is already in the target status.
 *
 * The same-reference short-circuit on no-op prevents spurious re-renders: if
 * the tab is already `idle` and we call `setTabStatus(tabs, id, 'idle')`, the
 * returned reference is `===` to the input and Zustand's shallow-equality
 * check sees no change.
 *
 * @param tabs    Current tab array from store state.
 * @param tabId   The tab to transition.
 * @param status  The target status.
 * @param guard   Optional predicate — transition fires only when guard(tab)
 *                returns true. When omitted, the transition is unconditional.
 */
export function setTabStatus(
  tabs: TabState[],
  tabId: string,
  status: TabStatus,
  guard?: (t: TabState) => boolean,
): TabState[] {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return tabs
  const tab = tabs[idx]
  if (guard && !guard(tab)) return tabs
  if (tab.status === status) return tabs
  const next = tabs.slice()
  next[idx] = { ...tab, status }
  return next
}
