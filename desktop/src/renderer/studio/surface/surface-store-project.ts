/**
 * Pure projection + normalization helpers for the surface store, extracted to
 * keep surface-store.ts under the file-size cap. These compute the visible tab
 * strip from persisted conversation state and never touch the store instance
 * (the store passes `set`/`get` to the action helpers that call these). The
 * `SurfaceState` import is type-only, so there is no runtime import cycle.
 */
import { useSessionStore } from "../../stores/sessionStore";
import {
  isBrowserTab,
  QUESTIONS_SURFACE_ID,
  type NotificationTab,
  type PinnableSingletonId,
  type ScratchTab,
  type SurfaceConversationPersisted,
  type SurfaceTab,
} from "../../../shared/studio-surface-types";
import {
  composeTabs,
  normalizeTabs,
} from "../../../shared/studio-surface-ordering";
import { scratchProjectKey, scratchTabsForProject } from "./surface-scratch";
import type { SurfaceState } from "./surface-store";

export function emptyConversation(): SurfaceConversationPersisted {
  return {
    tabs: [],
    activeTabId: null,
    visible: false,
    agentBrowserInstanceId: null,
  };
}

export function projectKeyForConversation(
  conversationId: string | null,
): string | null {
  const tab = useSessionStore
    .getState()
    .tabs.find((item) => item.id === conversationId);
  return scratchProjectKey(tab);
}

export function visibleTabs(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
  conversation: SurfaceConversationPersisted,
  scratchTabs: readonly ScratchTab[] = [],
  hasQuestions = false,
): SurfaceTab[] {
  // The Questions tab is an explicit FORCED group ahead of the global pins:
  // composeTabs puts pins first, so changing SINGLETON_ORDER alone could
  // never place a needs-you surface leftmost. Window-transient — derived
  // from the coordinator state, never part of conversation.tabs.
  const forced: SurfaceTab[] = hasQuestions
    ? [{ kind: "questions", id: QUESTIONS_SURFACE_ID }]
    : [];
  return [
    ...forced,
    ...composeTabs(
      pinnedTabs,
      conversation.tabs,
      conversation.agentBrowserInstanceId,
    ),
    ...scratchTabs,
    ...(notification ? [notification] : []),
  ];
}

export function globalTabIds(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
): string[] {
  return [...pinnedTabs, ...(notification ? [notification.id] : [])];
}

export function normalizeConversation(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
  conversation: SurfaceConversationPersisted,
  scratchTabs: readonly ScratchTab[] = [],
  hasQuestions = false,
): SurfaceConversationPersisted {
  const tabs = normalizeTabs(
    conversation.tabs.filter(
      (tab) =>
        !(
          tab.kind === "singleton" &&
          pinnedTabs.includes(tab.id as PinnableSingletonId)
        ),
    ),
    conversation.agentBrowserInstanceId,
  );
  // A pointer whose tab is gone is dropped here rather than carried as a
  // dangling id: the strip would otherwise claim a link that nothing renders.
  // Dropping is safe because closing the linked tab is exactly the case where
  // the next agent call is supposed to create a fresh one.
  const agentBrowserInstanceId =
    conversation.agentBrowserInstanceId &&
    tabs.some(
      (tab) =>
        isBrowserTab(tab) &&
        tab.instanceId === conversation.agentBrowserInstanceId,
    )
      ? conversation.agentBrowserInstanceId
      : null;
  const composed = visibleTabs(
    pinnedTabs,
    notification,
    { ...conversation, tabs, agentBrowserInstanceId },
    scratchTabs,
    hasQuestions,
  );
  return {
    tabs,
    visible: conversation.visible,
    agentBrowserInstanceId,
    activeTabId:
      conversation.activeTabId &&
      composed.some((tab) => tab.id === conversation.activeTabId)
        ? conversation.activeTabId
        : (composed[0]?.id ?? null),
  };
}

export function project(
  state: Pick<
    SurfaceState,
    | "pinnedTabs"
    | "notification"
    | "scratchProjects"
    | "conversations"
    | "currentConversationId"
    | "visible"
  > & { questionsConversations?: Set<string> },
): Pick<SurfaceState, "tabs" | "activeTabId" | "conversations" | "visible"> {
  if (!state.currentConversationId)
    return {
      tabs: [],
      activeTabId: null,
      conversations: state.conversations,
      visible: state.visible,
    };
  const hasQuestions =
    state.questionsConversations?.has(state.currentConversationId) ?? false;
  const scratchTabs = scratchTabsForProject(
    state.scratchProjects,
    projectKeyForConversation(state.currentConversationId),
  );
  const current = normalizeConversation(
    state.pinnedTabs,
    state.notification,
    state.conversations[state.currentConversationId] ?? emptyConversation(),
    scratchTabs,
    hasQuestions,
  );
  const conversations = {
    ...state.conversations,
    [state.currentConversationId]: current,
  };
  return {
    tabs: visibleTabs(
      state.pinnedTabs,
      state.notification,
      current,
      scratchTabs,
      hasQuestions,
    ),
    activeTabId: current.activeTabId,
    conversations,
    visible: state.visible,
  };
}

/**
 * Whether closing a tab emptied the panel for the current conversation.
 *
 * `tabs` here is the already-projected strip (pins, notification, scratch,
 * and the forced Questions tab all included), so this is only true when
 * nothing is left to show — a Questions tab present for an in-progress
 * workflow keeps the panel open, which is the desired refusal.
 */
export function panelEmptiedByClose(
  tabs: readonly SurfaceTab[],
  visible: boolean,
): boolean {
  return visible && tabs.length === 0;
}

/**
 * Close the panel when a tab close left the current conversation's strip
 * empty. Called after every closeTab completion path rather than folded into
 * `updateCurrent`, since most callers (activateTab, pinTab, renames, ...)
 * never remove a tab and must not risk collapsing the panel on a no-op.
 */
export function closePanelIfEmptied(get: () => SurfaceState): void {
  const state = get();
  if (panelEmptiedByClose(state.tabs, state.visible)) {
    state.setVisible(false);
  }
}
