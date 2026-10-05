import type { InboxTabView } from '@ion/shared/inbox-classify'
import { liveBackgroundShellCount } from '@ion/shared/background-shell-counts'
import { activeInstance } from './conversation-instance'
import { activeQuestionsCount } from './questions-read'
import { usageLimitedUntil } from '@ion/shared/usage-limit'
import type { State } from './session-store-types'

/**
 * The owner's view of one conversation, in the shape the Inbox rules read.
 *
 * One builder for every server rule that asks "is this conversation at rest":
 * the automatic-settlement sweep, the settle mutation's own refusal, and the
 * conversation-finished push. A pending ask, a pending plan, or running
 * background work read the same way in all three.
 */
export function inboxTabView(state: State, tab: State['tabs'][number]): InboxTabView {
  const instance = activeInstance(state.conversationPanes, tab.id)
  // Active guided-question workflows block like any pending ask.
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
    limited: usageLimitedUntil(tab, Date.now()) !== null,
  }
}
