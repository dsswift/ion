import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import type { ConversationPane } from '../../../shared/types-engine'
import { usePreferencesStore } from '../../preferences'
import { cancelDoneGroupMove } from '../session-store-helpers'
import { effectivePermissionMode } from '../conversation-instance'
import { isMirrorWindow } from '../../lib/window-role'
import { rDebug, rInfo } from '../../rendererLogger'

/**
 * Resolve the auto-group a tab belongs in for its CURRENT permission mode, and
 * move it there if needed. This is the single decision body shared by the two
 * triggers that put a tab into the planning / in-progress groups:
 *
 *   1. SEND   — `applySendAutoGroupMove` (send-slice.ts), fired when the local
 *               user presses send.
 *   2. RUNNING — `maybeScheduleRunningMove` (below), fired when a tab transitions
 *               INTO a running state via `handleStatusChange` — i.e. ANY path
 *               that starts a run, including session resume, engine relaunch +
 *               re-activation, reconnect, or a remote/iOS-initiated run that does
 *               not route through the desktop send actions.
 *
 * WHY THIS IS SHARED (not duplicated):
 * Before this helper existed the planning/in-progress move lived only inside the
 * send actions, so a tab driven back to `running` by a non-send path (the cases
 * above) never re-evaluated its group and was stranded — most visibly, a tab that
 * had previously completed in auto mode (auto-moved to DONE) and then resumed:
 * it ran while sitting in the DONE group. The done-move is event-driven (fires
 * from `handleStatusChange(idle)`); this is its symmetric `running` counterpart.
 *
 * MODE → GROUP mapping (authoritative `effectivePermissionMode`, which resolves
 * instance-vs-parent so engine/extension tabs are handled correctly):
 *   - `plan` → planningGroupId
 *   - `auto` → inProgressGroupId
 *
 * GUARDS (identical to the send path, mirroring event-slice-done-move.ts):
 *   - `autoGroupMovement` enabled, `tabGroupMode === 'manual'`, the target group
 *     is configured, and the tab is not already in it.
 *   - the tab is not pinned (`groupPinned`) — a pinned tab stays where the user
 *     put it.
 *
 * @param tabId   the tab to (maybe) move
 * @param tab     the tab as it currently is (read for groupId / groupPinned)
 * @param panes   conversationPanes, for the authoritative permission-mode read
 * @param get     the store getter, used to invoke `moveTabToGroup`
 * @param source  a short tag identifying the call site, for log correlation
 * @returns true if a move was issued, false otherwise
 */
export function applyActiveGroupMove(
  tabId: string,
  tab: TabState,
  panes: Map<string, ConversationPane>,
  get: () => State,
  source: string,
): boolean {
  // MIRROR GUARD: auto-group movement is an OWNER decision. The ATV mirror
  // ingests the same event stream, so without this guard both windows
  // evaluated every trigger — and the mirror's copy read its own (possibly
  // stale) permission mode, then FORWARDED moveTabToGroup to the owner,
  // overwriting the owner's correct move. (Observed: implement-and-unpin
  // moved the tab to in-progress in the owner, then the mirror's
  // status_change re-evaluation — still seeing mode 'plan' pre-sync — moved
  // it to planning.) The owner's own reducer makes the move; the mirror
  // receives the result via tabs-sync.
  if (isMirrorWindow()) {
    rDebug('auto-move.active', 'skipped: mirror window', { source, tab_id: tabId.slice(0, 8) })
    return false
  }
  const mode = effectivePermissionMode(tab, panes)
  const { autoGroupMovement, tabGroupMode, planningGroupId, inProgressGroupId } = usePreferencesStore.getState()
  rDebug('auto-move.active', 'evaluating', { source, tab_id: tabId.slice(0, 8), mode, auto_group: autoGroupMovement, tab_group_mode: tabGroupMode, pinned: tab.groupPinned, current_group: tab.groupId ?? '', in_progress_group: inProgressGroupId ?? '', planning_group: planningGroupId ?? '' })

  if (!(autoGroupMovement && tabGroupMode === 'manual')) {
    return false
  }
  if (tab.groupPinned) {
    const wouldMoveTo = mode === 'plan' ? planningGroupId : inProgressGroupId
    rDebug('auto-move.active', 'suppressed: tab pinned', { source, tab_id: tabId.slice(0, 8), current_group: tab.groupId ?? '', would_move_to: wouldMoveTo ?? '' })
    return false
  }

  if (mode === 'plan' && planningGroupId && tab.groupId !== planningGroupId) {
    rInfo('auto-move.active', 'moving to planning group', { source, tab_id: tabId.slice(0, 8), planning_group: planningGroupId })
    get().moveTabToGroup(tabId, planningGroupId)
    return true
  }
  if (mode === 'auto' && inProgressGroupId && tab.groupId !== inProgressGroupId) {
    rInfo('auto-move.active', 'moving to in-progress group', { source, tab_id: tabId.slice(0, 8), in_progress_group: inProgressGroupId })
    get().moveTabToGroup(tabId, inProgressGroupId)
    return true
  }

  rDebug('auto-move.active', 'no-op: already in correct group', { source, tab_id: tabId.slice(0, 8), current_group: tab.groupId ?? '' })
  return false
}

/**
 * Move a tab into its planning / in-progress group when it transitions INTO a
 * running state, regardless of how the run started. This is the event-driven
 * counterpart to `maybeScheduleDoneMove` — both hang off `handleStatusChange`,
 * the single chokepoint every status transition passes through.
 *
 * TRIGGER GRANULARITY: fires on a transition whose `newStatus` is `running`,
 * NOT `connecting`. `connecting` is a transient pre-run state that can abort
 * immediately (e.g. a blocked send, an engine that never starts); moving on it
 * would thrash the tab between groups. `running` is the committed run state, so
 * it is the stable point to re-evaluate the group.
 *
 * DONE-MOVE INTERACTION: a pending done-move (scheduled by a prior `task_complete`
 * or `idle` transition) is cancelled here on the running transition. The done-move
 * callback already re-checks status and bails if the tab is running, but that
 * re-check only protects the WINDOW before the timer fires; cancelling eagerly on
 * the running transition removes the stale timer outright so there is no race
 * where the done-move executes between the status flip and the re-check. This
 * mirrors the send path, which cancels the pending done-move for the same reason.
 *
 * @param tabId      the tab that reached a running state
 * @param prevStatus the tab's status BEFORE this transition
 * @param newStatus  the status the tab is transitioning to (move only on 'running')
 * @param updatedTab the tab as it will be after the transition (groupId/groupPinned)
 * @param panes      conversationPanes, for the authoritative permission-mode read
 * @param get        the store getter
 * @param source     a short tag identifying the call site, for log correlation
 */
export function maybeScheduleRunningMove(
  tabId: string,
  prevStatus: string,
  newStatus: string,
  updatedTab: TabState,
  panes: Map<string, ConversationPane>,
  get: () => State,
  source: string,
): void {
  if (newStatus !== 'running') {
    return
  }
  // A genuine entry into running supersedes any pending done-move from a prior
  // completion. Cancel it so the tab is not yanked to done mid-run.
  if (cancelDoneGroupMove(tabId)) {
    rDebug('auto-move.active', 'cancelled pending done-move on running transition', { tab_id: tabId.slice(0, 8), source })
  }
  rInfo('auto-move.active', 'running transition', { source, tab_id: tabId.slice(0, 8), prev_status: prevStatus, status: newStatus })
  applyActiveGroupMove(tabId, updatedTab, panes, get, source)
}
