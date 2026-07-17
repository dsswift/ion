// Post-commit plan-mode auto-group-movement helper, extracted from event-slice.ts
// to keep that file under the 600-line cap (Fix 1 / file-architecture rule).
//
// Called AFTER the set() reducer commits in handleNormalizedEvent — never inside
// the reducer — so the store read reflects the freshly-committed instance state.
// Mirrors the setPermissionMode post-commit pattern (tab-slice.ts:89-93).
import type { State } from '../session-store-types'
import type { ConversationPane } from '../../../shared/types-engine'
import type { TabState } from '../../../shared/types'
import { applyActiveGroupMove } from './event-slice-running-move'
import { rDebug, rInfo } from '../../rendererLogger'

/**
 * After an `engine_plan_mode_changed` or `engine_plan_proposal` event commits,
 * re-evaluate the auto-group for the tab if it is currently running/connecting
 * and the committed instance permissionMode is now 'plan'.
 *
 * WHY POST-COMMIT (not inside the reducer):
 * `applyActiveGroupMove` calls `moveTabToGroup`, which is a Zustand action. Calling
 * a store action from inside an active `set()` reducer nests a store write inside
 * another store write — Zustand treats this as a new transaction, but it reads the
 * PREVIOUS state, not the state that the outer set is about to produce. The result
 * is that `effectivePermissionMode` inside `applyActiveGroupMove` reads the
 * pre-commit 'auto' value and the guard never fires. Running the call here, after
 * set() returns, guarantees the fresh state is visible.
 *
 * Mirrors the setPermissionMode post-commit pattern (tab-slice.ts:89-93).
 *
 * GUARD SEMANTICS:
 *   - `eventType` must be `engine_plan_mode_changed` or `engine_plan_proposal`.
 *   - freshTab.status must be running or connecting (idle tabs not re-grouped mid-run).
 *   - The committed instance permissionMode must be 'plan' (read via
 *     effectivePermissionMode inside applyActiveGroupMove — authoritative).
 *   - The pinned guard (applyActiveGroupMove:63-69) and autoGroupMovement guard
 *     (applyActiveGroupMove:60-62) apply for free inside the delegated call.
 *
 * @param tabId      the tab that received the event
 * @param eventType  the event type string (check performed here, not in the caller)
 * @param get        the store getter (read after commit, so state is fresh)
 */
export function maybeApplyPlanModeGroupMove(
  tabId: string,
  eventType: string,
  get: () => State,
): void {
  if (eventType !== 'engine_plan_mode_changed' && eventType !== 'engine_plan_proposal') return

  const freshState = get()
  const freshTab: TabState | undefined = freshState.tabs.find((t) => t.id === tabId)
  const freshPanes: Map<string, ConversationPane> = freshState.conversationPanes

  if (!freshTab) {
    rDebug('auto-move.plan-mode', 'tab not found post-commit, skipping', { tab_id: tabId.slice(0, 8) })
    return
  }

  const status = freshTab.status
  if (status !== 'running' && status !== 'connecting') {
    rDebug('auto-move.plan-mode', 'tab not active, skipping', { tab_id: tabId.slice(0, 8), status })
    return
  }

  rInfo('auto-move.plan-mode', 'post-commit check', { tab_id: tabId.slice(0, 8), status })
  applyActiveGroupMove(tabId, freshTab, freshPanes, get, 'plan_mode_event')
}
