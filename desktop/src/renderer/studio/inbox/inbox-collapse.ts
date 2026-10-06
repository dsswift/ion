import type { ConversationPane } from "@ion/shared/types-engine";
import type { TabState } from "@ion/shared/types";
import type { InboxSortOrder } from "./inbox-sort";
import { sortPinnedByOrder } from "@ion/shared/inbox-pin-order";
import { inboxActivityOrder } from "@ion/shared/inbox-classify";
import { evaluateSessionBusyGuard } from "@ion/server/store/slices/session-busy-guard";

export { inboxActivityOrder };

function activityTime(tab: TabState): number {
  return tab.lastActivityAt ?? tab.lastMessageAt ?? tab.createdAt ?? 0;
}

/**
 * Applies the Inbox sort choice with deterministic fallbacks for new tabs.
 * With `workingLast`, conversations it names as working keep that order
 * among themselves but sit below every conversation that is not: the ones
 * that need a look lead, the ones that need nothing follow.
 */
export function orderInboxTabs(
  tabs: readonly TabState[],
  order: InboxSortOrder,
  workingLast?: (tab: TabState) => boolean,
): TabState[] {
  const sorted = sortInboxTabs(tabs, order);
  if (!workingLast) return sorted;
  const working = sorted.filter(workingLast);
  return working.length === 0 ? sorted : [...sorted.filter((tab) => !workingLast(tab)), ...working];
}

function sortInboxTabs(tabs: readonly TabState[], order: InboxSortOrder): TabState[] {
  return [...tabs].sort((left, right) =>
    order === "title"
      ? (left.customTitle ?? left.title).localeCompare(
          right.customTitle ?? right.title,
        ) || left.id.localeCompare(right.id)
      : order === "created"
        ? (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
          left.id.localeCompare(right.id)
        : activityTime(right) - activityTime(left) ||
          left.id.localeCompare(right.id),
  );
}


/**
 * True when the conversation still has foreground or background work in flight.
 *
 * The session-busy guard is the canonical all-instance fold for child agents,
 * pending accepted work, and background shells. Tab status covers CLI and
 * pre-status windows where the conversation pane does not yet carry state.
 *
 * 'starting' is not work: it is a session attaching with nothing asked of it,
 * which every restored conversation passes through at server boot. A submitted
 * prompt holds 'connecting' through the attach instead.
 */
export function isInboxTabWorking(
  tab: Pick<TabState, "status">,
  pane: ConversationPane | undefined,
): boolean {
  if (
    tab.status === "connecting" ||
    tab.status === "running" ||
    tab.status === "waiting"
  )
    return true;
  const guard = evaluateSessionBusyGuard(pane);
  return (
    (guard.orchestratorRunning && !guard.orchestratorAttachingOnly) ||
    guard.childCounts.some((child) => child.count > 0) ||
    guard.shellCount > 0
  );
}

export function worktreeChildRows(
  tabs: readonly TabState[],
  collapsed: boolean,
  activeTabId: string | null = null,
  workingTabIds: ReadonlySet<string> = new Set(),
): TabState[] {
  return collapsed
    ? collapsedInboxRows(tabs, activeTabId, workingTabIds)
    : [...tabs];
}

/** Select the next conversation in activity order and wrap at the end. */
export function nextInboxConversation<
  T extends Pick<TabState, "id" | "lastActivityAt">,
>(tabs: readonly T[], activeTabId: string): T | null {
  const ordered = inboxActivityOrder(tabs);
  if (ordered.length === 0) return null;
  const activeIndex = ordered.findIndex((tab) => tab.id === activeTabId);
  return activeIndex < 0
    ? ordered[0]
    : ordered[(activeIndex + 1) % ordered.length];
}

/**
 * Rows that remain visible under a collapsed project or location group.
 * Pinned rows retain their saved order, followed by the selected row and then
 * working rows in navigator order. A row can satisfy several rules but renders once.
 */
export function collapsedInboxRows(
  tabs: readonly TabState[],
  activeTabId: string | null = null,
  workingTabIds: ReadonlySet<string> = new Set(),
): TabState[] {
  const visible = sortPinnedByOrder(tabs.filter((tab) => tab.pinnedAt != null));
  const included = new Set(visible.map((tab) => tab.id));
  const append = (tab: TabState | undefined): void => {
    if (tab && !included.has(tab.id)) {
      visible.push(tab);
      included.add(tab.id);
    }
  };

  append(tabs.find((tab) => tab.id === activeTabId));
  for (const tab of tabs) if (workingTabIds.has(tab.id)) append(tab);
  return visible;
}

/** The keys that occur more than once, each listed once, in first-seen order. */
export function duplicateKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) repeated.add(key)
    seen.add(key)
  }
  return [...repeated]
}
