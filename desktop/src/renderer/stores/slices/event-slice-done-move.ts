import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import type { ConversationPane } from '../../../shared/types-engine'
import { usePreferencesStore } from '../../preferences'
import { scheduleDoneGroupMove } from '../session-store-helpers'
import { activeInstance, effectivePermissionMode } from '../conversation-instance'
import { isMirrorWindow } from '../../lib/window-role'
import { rDebug, rInfo } from '../../rendererLogger'

/**
 * Schedule the auto-move-to-done-group for a tab that has just reached a clean
 * terminal state after running in auto mode.
 *
 * WHY THIS IS A SHARED HELPER (not inline in one event handler):
 * The done-group move must fire on EVERY path that takes a running auto-mode tab
 * to a clean terminal state — not just `task_complete`. There are at least two
 * such paths in production:
 *
 *   1. `task_complete` (the normal completion synthesized by the control plane
 *      from `engine_status state=idle`).
 *   2. `handleStatusChange(tabId, 'idle')` driven by `engine_dead` clean-exit
 *      (exitCode 0/null/undefined, no signal). The control plane's
 *      `handleDeadEvent` sets status straight to `idle` WITHOUT emitting a
 *      `task_complete`, so the inline `case 'task_complete'` logic never ran and
 *      the tab was stranded in the in-progress group. A subsequent reconnect
 *      `state=idle` is then suppressed by the control plane's already-idle guard,
 *      so it gets no second chance. The renderer's `handleStatusChange` is the
 *      single chokepoint every terminal transition passes through, so the move
 *      must be reachable from there.
 *
 * GUARDS (all preserved from the original inline `task_complete` block):
 *   - `prevStatus === 'running'` — only a running→terminal transition initiates a
 *     move. A heartbeat `idle`-after-`completed` tick (prevStatus 'completed') is
 *     NOT a fresh completion and must not move.
 *   - clean terminal state only (`idle` / `completed`), never `dead` / `failed` —
 *     a failure is not a completion.
 *   - `effectivePermissionMode === 'auto'` — plan-mode tabs are awaiting approval.
 *   - `permissionDenied === null` — a permission-blocked tab is not done.
 *   - no running dispatched background agents — the orchestrator may go idle the
 *     moment it fires the dispatch tool, while the child agent has not yet reported
 *     running. The engine delivers agent_state snapshots with `status=running`
 *     before (or concurrent with) the orchestrator idle transition and those
 *     entries persist in the store until the engine sends a terminal snapshot.
 *     Folding `panes[tabId].instances[*].agentStates` for any `status === 'running'`
 *     entry reliably covers this gap without a race: if `agentStates` shows
 *     running children at schedule time, the tab is not done. The re-check at
 *     timer-fire time re-reads the same path for defense-in-depth.
 *   - `autoGroupMovement` enabled, `tabGroupMode === 'manual'`, a `doneGroupId`
 *     configured, the tab is not already in the done group, and the tab is not
 *     pinned.
 *
 * IDEMPOTENCY: `scheduleDoneGroupMove` calls `cancelDoneGroupMove` first, so at
 * most one move is ever pending per tab. When both a `task_complete` and a
 * follow-on `setStatus('idle')` arrive for the same genuine completion, the
 * second schedule simply resets the same 1500ms timer — no duplicate
 * `moveTabToGroup`.
 *
 * @param tabId        the tab that reached a terminal state
 * @param prevStatus   the tab's status BEFORE this transition (must be 'running'
 *                     for the move to fire)
 * @param newStatus    the terminal status the tab is transitioning to
 * @param updatedTab   the tab as it will be after the transition (read for
 *                     groupId / groupPinned)
 * @param panes        conversationPanes, for the authoritative permission-mode,
 *                     permission-denied, and agentStates reads
 * @param get          the store getter, used by the delayed re-check + the move
 * @param source       a short tag identifying the call site, for log correlation
 * @param deniedOverride
 *                     when the caller has already computed the active instance's
 *                     permission-denied state for THIS tick but has not yet
 *                     committed it to `panes` (the `task_complete` path sets
 *                     `instPatch.permissionDenied` in the same reducer), pass it
 *                     here so the guard reads the fresh value rather than the
 *                     stale committed one. Omit (undefined) to read from `panes`.
 */
export function maybeScheduleDoneMove(
  tabId: string,
  prevStatus: string,
  newStatus: string,
  updatedTab: TabState,
  panes: Map<string, ConversationPane>,
  get: () => State,
  source: string,
  deniedOverride?: boolean,
): void {
  // MIRROR GUARD: same contract as applyActiveGroupMove — group movement is
  // an OWNER decision. Both windows ingest the status stream, so without
  // this guard every done-move was scheduled and executed twice (owner +
  // mirror forwarding), with the mirror deciding from possibly-stale state.
  if (isMirrorWindow()) {
    rDebug('auto-move.done', 'skipped: mirror window', { source, tab_id: tabId.slice(0, 8) })
    return
  }
  // Only a clean terminal state reached FROM a running state is a completion.
  const isCleanTerminal = newStatus === 'idle' || newStatus === 'completed'
  const mode = effectivePermissionMode(updatedTab, panes)
  const denied = deniedOverride ?? (activeInstance(panes, tabId)?.permissionDenied != null)

  if (prevStatus !== 'running' || !isCleanTerminal || mode !== 'auto' || denied) {
    rDebug('auto-move.done', 'skipped', { source, tab_id: tabId.slice(0, 8), prev_status: prevStatus, status: newStatus, mode, denied })
    return
  }

  // Guard: do not move while dispatched background agents are still running.
  // The orchestrator goes idle the moment it fires the dispatch tool; the child
  // agent reports running via a subsequent agent_state snapshot. That snapshot
  // persists in the store, so this fold is not racy — if children are running,
  // the store already knows.
  const hasRunningChildren = hasRunningAgents(panes, tabId)
  if (hasRunningChildren) {
    rDebug('auto-move.done', 'skipped: running children', { source, tab_id: tabId.slice(0, 8) })
    return
  }

  const { autoGroupMovement, tabGroupMode, doneGroupId } = usePreferencesStore.getState()
  rDebug('auto-move.done', 'evaluating', { source, tab_id: tabId.slice(0, 8), auto_group: autoGroupMovement, tab_group_mode: tabGroupMode, done_group: doneGroupId ?? '', current_group: updatedTab.groupId ?? '', pinned: updatedTab.groupPinned })
  if (!(autoGroupMovement && tabGroupMode === 'manual' && doneGroupId && updatedTab.groupId !== doneGroupId)) {
    return
  }
  if (updatedTab.groupPinned) {
    rDebug('auto-move.done', 'suppressed: tab pinned', { source, tab_id: tabId.slice(0, 8), current_group: updatedTab.groupId ?? '', would_move_to: doneGroupId })
    return
  }
  rInfo('auto-move.done', 'scheduling move', { source, tab_id: tabId.slice(0, 8), done_group: doneGroupId })
  const capturedDoneGroupId = doneGroupId
  scheduleDoneGroupMove(tabId, 1500, () => {
    // Re-check: the tab may have started new work since the timer was scheduled
    // (e.g. the engine's warmup idle fired, then state=running arrived for the
    // real work, or a relaunch+resume re-activated the tab). Only move if the
    // tab is actually done.
    const currentTab = get().tabs.find((t) => t.id === tabId)
    if (currentTab && (currentTab.status === 'running' || currentTab.status === 'connecting')) {
      rDebug('auto-move.done', 'cancelled: tab still active', { source, tab_id: tabId.slice(0, 8), status: currentTab.status })
      return
    }
    // Re-check: a running child agent_state snapshot may have arrived after the
    // timer was scheduled (reverse-ordering from the typical case). Suppress the
    // move — the done-group move will re-trigger once the children complete and
    // the orchestrator receives their terminal agent_state.
    const stillHasRunningChildren = hasRunningAgents(get().conversationPanes, tabId)
    if (stillHasRunningChildren) {
      rDebug('auto-move.done', 'cancelled: running children arrived after schedule', { source, tab_id: tabId.slice(0, 8) })
      return
    }
    rInfo('auto-move.done', 'executing move', { source, tab_id: tabId.slice(0, 8), done_group: capturedDoneGroupId, status: currentTab?.status ?? '' })
    get().moveTabToGroup(tabId, capturedDoneGroupId)
  })
}

/**
 * Return true when any instance under `tabId` has at least one dispatched
 * background agent with `status === 'running'`. Folds across all instances so
 * it is correct for both plain (single-main-instance) and multi-instance engine
 * tabs. Mirrors the fold in `anyEngineInstanceHasRunningChildren` (TabStripShared)
 * and the `evaluateCloseGuard` predicate (tab-close-guard), which use the same
 * signal to drive the tab-pill yellow dot and the Cmd+W hard-block respectively.
 */
function hasRunningAgents(panes: Map<string, ConversationPane>, tabId: string): boolean {
  const pane = panes.get(tabId)
  if (!pane) return false
  for (const inst of pane.instances) {
    for (const a of inst.agentStates) {
      if (a.status === 'running') return true
    }
  }
  return false
}
