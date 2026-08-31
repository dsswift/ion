/**
 * Forks awaiting their first durable conversation id.
 *
 * ── Why a fork cannot reconcile at creation time ────────────────────────────
 * A fork copies its source's active-branch messages — chart rows included — but
 * is born with `conversationId: null`. The engine mints the durable id later,
 * and a chart resource is CONVERSATION-SCOPED: publishing before the id exists
 * would either be refused by the broker (no session to route to) or, worse,
 * write an index under an empty scope that nothing ever reads.
 *
 * So the fork registers here, and the `session_init` reducer — the one place
 * every conversation kind learns its durable id — drains the marker once and
 * reconciles then. A Set rather than store state because this is transient
 * plumbing for a single handoff, not something any view renders or any
 * snapshot projects.
 */
import { reconcileChartsForBranch } from '../../lib/chart-reconcile-request'
import type { Message } from '../../../shared/types'

const pendingForks = new Set<string>()
/** Mark a freshly-created fork as owing a chart reconcile. */
export function markForkPendingChartReconcile(tabId: string): void {
  if (!tabId) return
  pendingForks.add(tabId)
}

/**
 * Claim a fork's pending marker, if it has one.
 *
 * Removes on read so the reconcile runs exactly once: `session_init` fires at
 * the start of every run, and re-reconciling on each one would republish the
 * same index for the life of the conversation.
 */
export function claimForkPendingChartReconcile(tabId: string): boolean {
  return pendingForks.delete(tabId)
}

/** Test-only: clear the pending set between cases. */
export function _resetForkChartReconcileForTest(): void {
  pendingForks.clear()
}

/**
 * Drain a fork's pending marker and reconcile its copied chart rows.
 *
 * Called post-commit from the `session_init` reducer, so the store already
 * holds the durable conversation id and the branch's committed messages. A tab
 * with no marker (every non-fork conversation) costs one Set lookup.
 */
export function maybeReconcileForkedCharts(
  tabId: string,
  get: () => {
    tabs: Array<{ id: string; conversationId: string | null }>
    conversationPanes: Map<string, ConversationPaneLike>
  },
): void {
  if (!claimForkPendingChartReconcile(tabId)) return
  const state = get()
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab?.conversationId) return
  const pane = state.conversationPanes.get(tabId)
  const inst = pane?.instances.find((candidate) => candidate.id === pane.activeInstanceId)
    ?? pane?.instances[0]
  reconcileChartsForBranch(tabId, tab.conversationId, inst?.messages ?? [])
}

/** The slice of a conversation pane this handoff reads. */
interface ConversationPaneLike {
  activeInstanceId: string | null
  instances: Array<{ id: string; messages: Message[] }>
}
