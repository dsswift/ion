import type { TabState } from '../../../shared/types'
import type { InboxSortOrder } from './InboxControls'
import { sortPinnedByOrder } from '../../../shared/inbox-pin-order'

function activityTime(tab: TabState): number {
  return tab.lastActivityAt ?? tab.lastMessageAt ?? tab.createdAt ?? 0
}

/** Applies the Inbox sort choice with deterministic fallbacks for new tabs. */
export function orderInboxTabs(tabs: readonly TabState[], order: InboxSortOrder): TabState[] {
  return [...tabs].sort((left, right) => order === 'title'
    ? (left.customTitle ?? left.title).localeCompare(right.customTitle ?? right.title) || left.id.localeCompare(right.id)
    : order === 'created'
      ? (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id)
      : activityTime(right) - activityTime(left) || left.id.localeCompare(right.id))
}

/** Conversations in navigation order: newest real activity first, then stable ID. */
export function inboxActivityOrder<T extends Pick<TabState, 'id' | 'lastActivityAt'>>(
  tabs: readonly T[],
): T[] {
  return [...tabs].sort((left, right) =>
    (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
      || left.id.localeCompare(right.id))
}

export function worktreeChildRows(
  tabs: readonly TabState[],
  collapsed: boolean,
): TabState[] {
  return collapsed ? collapsedInboxRows(tabs) : [...tabs]
}

/** Select the next conversation in activity order and wrap at the end. */
export function nextInboxConversation<T extends Pick<TabState, 'id' | 'lastActivityAt'>>(
  tabs: readonly T[],
  activeTabId: string,
): T | null {
  const ordered = inboxActivityOrder(tabs)
  if (ordered.length === 0) return null
  const activeIndex = ordered.findIndex((tab) => tab.id === activeTabId)
  return activeIndex < 0 ? ordered[0] : ordered[(activeIndex + 1) % ordered.length]
}

/** Rows that remain visible under a collapsed project or location group: pinned only. */
export function collapsedInboxRows(
  tabs: readonly TabState[],
): TabState[] {
  return sortPinnedByOrder(tabs.filter((tab) => tab.pinnedAt != null))
}
