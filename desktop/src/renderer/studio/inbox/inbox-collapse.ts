import type { ConversationPane } from "../../../shared/types-engine";
import type { TabState } from "../../../shared/types";
import type { InboxSortOrder } from "./InboxControls";
import { sortPinnedByOrder } from "../../../shared/inbox-pin-order";
import { evaluateSessionBusyGuard } from "../../stores/slices/session-busy-guard";

function activityTime(tab: TabState): number {
  return tab.lastActivityAt ?? tab.lastMessageAt ?? tab.createdAt ?? 0;
}

/** Applies the Inbox sort choice with deterministic fallbacks for new tabs. */
export function orderInboxTabs(
  tabs: readonly TabState[],
  order: InboxSortOrder,
): TabState[] {
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

/** Conversations in navigation order: newest real activity first, then stable ID. */
export function inboxActivityOrder<
  T extends Pick<TabState, "id" | "lastActivityAt">,
>(tabs: readonly T[]): T[] {
  return [...tabs].sort(
    (left, right) =>
      (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * True when the conversation still has foreground or background work in flight.
 *
 * The session-busy guard is the canonical all-instance fold for child agents,
 * pending accepted work, and background shells. Tab status covers CLI and
 * pre-status windows where the conversation pane does not yet carry state.
 */
export function isInboxTabWorking(
  tab: Pick<TabState, "status">,
  pane: ConversationPane | undefined,
): boolean {
  if (
    tab.status === "connecting" ||
    tab.status === "starting" ||
    tab.status === "running" ||
    tab.status === "waiting"
  )
    return true;
  return evaluateSessionBusyGuard(pane).blocked;
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
