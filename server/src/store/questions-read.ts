/**
 * Server-side questions read-helpers — used by the store's Inbox rules and
 * cross-client snapshot builder.
 *
 * Unlike the desktop renderer's `questions-store.ts` (a window-local zustand
 * cache synced from main via IPC broadcast + hydration), the server holds
 * the authoritative `QuestionsCoordinator` directly in this process
 * (`questions/questions-wiring.ts`). There is no replica to sync — every
 * read here goes straight to the coordinator's live snapshot.
 */
import { questionsSnapshot } from '../questions/questions-wiring'
import type { QuestionsWorkflowState } from '@ion/shared/questions-state'

/**
 * Open (renderable) workflows for one tab, oldest first. Terminal states are
 * excluded — the same rule the coordinator's own openForSession applies,
 * duplicated read-side because terminal states DO transit the broadcast once
 * (for dismissal animations). Matches by engine-key prefix: extension-hosted
 * sessions key as `tabId:instanceId`.
 */
export function openWorkflowsForTab(
  workflows: QuestionsWorkflowState[],
  tabId: string,
): QuestionsWorkflowState[] {
  return workflows
    .filter((w) => {
      const wfTab = w.sessionKey.includes(':') ? w.sessionKey.slice(0, w.sessionKey.indexOf(':')) : w.sessionKey
      return wfTab === tabId && w.phase !== 'terminal'
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Number of active guided waits on a tab, read live from the coordinator.
 * Feeds the Inbox rules (pendingAskCount, snooze eligibility, auto-settle
 * guards): an open guided wait is an operator decision pending, so the tab
 * must not snooze or auto-settle under it.
 */
export function activeQuestionsCount(tabId: string): number {
  return openWorkflowsForTab(questionsSnapshot().workflows, tabId).length
}
