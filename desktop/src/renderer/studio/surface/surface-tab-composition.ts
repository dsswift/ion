import { composeTabs } from "../../../shared/studio-surface-ordering";
import type {
  NotificationTab,
  PinnableSingletonId,
  ScratchTab,
  SurfaceConversationPersisted,
  SurfaceTab,
} from "../../../shared/studio-surface-types";
import { QUESTIONS_SURFACE_ID } from "../../../shared/studio-surface-types";

/** Compose the current conversation tabs with global and transient tabs. */
export function visibleSurfaceTabs(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
  conversation: SurfaceConversationPersisted,
  scratchTabs: readonly ScratchTab[] = [],
  hasQuestions = false,
): SurfaceTab[] {
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

/** Return global tab ids that close-all actions must preserve. */
export function globalSurfaceTabIds(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
): string[] {
  return [...pinnedTabs, ...(notification ? [notification.id] : [])];
}
