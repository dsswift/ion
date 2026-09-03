import { useSessionStore } from "../../stores/sessionStore";
import {
  NOTIFICATION_SURFACE_ID,
  QUESTIONS_SURFACE_ID,
  type PinnableSingletonId,
  type SurfaceConversationPersisted,
} from "../../../shared/studio-surface-types";
import { rDebug, rInfo, rWarn } from "../../rendererLogger";
import { teardownSurfaceTab } from "./surface-tab-lifecycle";
import {
  closeOthersTargets,
  closeToRightTargets,
  nextActiveAfterClose,
  normalizeTabs,
} from "../../../shared/studio-surface-ordering";
import { normalizePinnedTabs } from "../../../shared/studio-surface-persistence";
import {
  emptyConversation,
  globalTabIds as globalSurfaceTabIds,
  project,
  projectKeyForConversation,
  visibleTabs as visibleSurfaceTabs,
} from "./surface-store-project";
import { scratchTabsForProject } from "./surface-scratch";
import type { SurfaceState } from "./surface-store";

type SetSurface = (partial: Partial<SurfaceState>) => void;
type GetSurface = () => SurfaceState;
type UpdateCurrent = (
  set: SetSurface,
  get: GetSurface,
  update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted,
) => void;

/** Create the active Canvas tab lifecycle actions. */
export function createSurfaceTabLifecycleActions({
  set,
  get,
  updateCurrent,
  schedulePersist,
}: {
  set: SetSurface;
  get: GetSurface;
  updateCurrent: UpdateCurrent;
  schedulePersist(get: GetSurface): void;
}): Pick<
  SurfaceState,
  | "activateTab"
  | "closeTab"
  | "closeOthers"
  | "closeToRight"
  | "pinTab"
  | "unpinTab"
  | "updateBrowserTab"
  | "renameTerminalTab"
> {
  return {
activateTab: (id) =>
  updateCurrent(set, get, (current) => {
    // The membership guard must see the SAME strip project() renders. Scratch
    // tabs live in the global scratchProjects map (not conversation.tabs) and
    // the Questions tab is coordinator-transient — both are appended only when
    // their arguments are passed. Omitting them here made activateTab a no-op
    // for a scratch tab: it never matched, so clicking it (or returning to it
    // after visiting another tab) silently kept the old active tab and the
    // document never loaded.
    const state = get();
    const scratchTabs = scratchTabsForProject(
      state.scratchProjects,
      projectKeyForConversation(state.currentConversationId),
    );
    const hasQuestions =
      !!state.currentConversationId &&
      state.questionsConversations.has(state.currentConversationId);
    return visibleSurfaceTabs(
      state.pinnedTabs,
      state.notification,
      current,
      scratchTabs,
      hasQuestions,
    ).some((tab) => tab.id === id)
      ? { ...current, activeTabId: id }
      : current;
  }),

closeTab: (id) => {
  const state = get();
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab) return;
  // The Questions tab refuses close while input/review is required: an
  // operator answer is what retires it (the synchronizer removes it when
  // the workflow completes). This single refusal covers every close verb
  // — middle-click, keyboard, context menu, closeOthers/closeToRight all
  // funnel here or exclude it structurally below.
  if (id === QUESTIONS_SURFACE_ID) {
    rDebug(
      "studio.surface",
      "questions tab close refused: workflow requires input",
      {},
    );
    return;
  }
  if (id === NOTIFICATION_SURFACE_ID && state.notification) {
    const notification = null;
    const conversations = { ...state.conversations };
    if (state.currentConversationId) {
      const current =
        conversations[state.currentConversationId] ?? emptyConversation();
      const remaining = visibleSurfaceTabs(
        state.pinnedTabs,
        notification,
        current,
      );
      conversations[state.currentConversationId] = {
        ...current,
        activeTabId:
          current.activeTabId === id
            ? (remaining[0]?.id ?? null)
            : current.activeTabId,
      };
    }
    set({
      ...project({ ...state, notification, conversations }),
      notification,
    });
    schedulePersist(get);
    rInfo("studio.surface", "workspace notification closed", {
      resource_id: state.notification.resourceId,
      resource_kind: state.notification.resourceKind,
    });
    return;
  }
  if (state.pinnedTabs.includes(id as PinnableSingletonId)) {
    const pinnedTabs = state.pinnedTabs.filter((tabId) => tabId !== id);
    const conversations = { ...state.conversations };
    if (state.currentConversationId) {
      const current =
        conversations[state.currentConversationId] ?? emptyConversation();
      const remaining = visibleSurfaceTabs(
        pinnedTabs,
        state.notification,
        current,
      );
      conversations[state.currentConversationId] = {
        ...current,
        activeTabId:
          current.activeTabId === id
            ? (remaining[0]?.id ?? null)
            : current.activeTabId,
      };
    }
    set({ ...project({ ...state, pinnedTabs, conversations }), pinnedTabs });
    schedulePersist(get);
    rInfo("studio.surface", "pinned surface tab closed", {
      surface_tab: id,
      tab_id: state.currentConversationId ?? "",
    });
    return;
  }
  if (tab.kind === "scratch") {
    get().requestScratchClose(tab.projectKey, tab.documentId);
    return;
  }
  if (tab.kind === "terminal") {
    const key = `${state.currentConversationId ?? "studio"}:surface:${tab.instanceId}`;
    const activity = useSessionStore.getState().terminalActivities?.get(key);
    if (activity?.active) {
      rWarn(
        "studio.surface",
        "terminal tab close refused: terminal activity is running",
        {
          surface_tab: id,
          tab_id: state.currentConversationId ?? "",
          terminal_key: key,
        },
      );
      return;
    }
  }
  teardownSurfaceTab(tab, state.currentConversationId);
  updateCurrent(set, get, (current) => ({
    ...current,
    tabs: current.tabs.filter((item) => item.id !== id),
    activeTabId:
      current.activeTabId === id
        ? nextActiveAfterClose(state.tabs, id)
        : current.activeTabId,
  }));
},

closeOthers: (id) => {
  const state = get();
  const targets = closeOthersTargets(state.tabs, id, [
    ...globalSurfaceTabIds(state.pinnedTabs, state.notification),
    QUESTIONS_SURFACE_ID,
  ])
    .filter((tab) => tab.kind !== "scratch")
    .filter(
      (tab) =>
        tab.kind !== "terminal" ||
        !useSessionStore
          .getState()
          .terminalActivities?.get(
            `${state.currentConversationId ?? "studio"}:surface:${tab.instanceId}`,
          )?.active,
    );
  for (const tab of targets)
    teardownSurfaceTab(tab, state.currentConversationId);
  const ids = new Set(targets.map((tab) => tab.id));
  updateCurrent(set, get, (current) => ({
    ...current,
    tabs: current.tabs.filter((tab) => !ids.has(tab.id)),
    activeTabId:
      current.activeTabId && ids.has(current.activeTabId)
        ? id
        : current.activeTabId,
  }));
},

closeToRight: (id) => {
  const state = get();
  const targets = closeToRightTargets(state.tabs, id, [
    ...globalSurfaceTabIds(state.pinnedTabs, state.notification),
    QUESTIONS_SURFACE_ID,
  ])
    .filter((tab) => tab.kind !== "scratch")
    .filter(
      (tab) =>
        tab.kind !== "terminal" ||
        !useSessionStore
          .getState()
          .terminalActivities?.get(
            `${state.currentConversationId ?? "studio"}:surface:${tab.instanceId}`,
          )?.active,
    );
  for (const tab of targets)
    teardownSurfaceTab(tab, state.currentConversationId);
  const ids = new Set(targets.map((tab) => tab.id));
  updateCurrent(set, get, (current) => ({
    ...current,
    tabs: current.tabs.filter((tab) => !ids.has(tab.id)),
    activeTabId:
      current.activeTabId && ids.has(current.activeTabId)
        ? id
        : current.activeTabId,
  }));
},

pinTab: (id) => {
  const state = get();
  if (state.pinnedTabs.includes(id)) return;
  const pinnedTabs = normalizePinnedTabs([...state.pinnedTabs, id]);
  const conversations = Object.fromEntries(
    Object.entries(state.conversations).map(([tabId, current]) => [
      tabId,
      { ...current, tabs: current.tabs.filter((tab) => tab.id !== id) },
    ]),
  );
  set({ ...project({ ...state, pinnedTabs, conversations }), pinnedTabs });
  schedulePersist(get);
  rInfo("studio.surface", "surface tab pinned", { surface_tab: id });
},

unpinTab: (id) => {
  const state = get();
  if (!state.pinnedTabs.includes(id)) return;
  const pinnedTabs = state.pinnedTabs.filter((item) => item !== id);
  const currentConversationId = state.currentConversationId;
  const conversations = { ...state.conversations };
  if (currentConversationId) {
    const current =
      conversations[currentConversationId] ?? emptyConversation();
    conversations[currentConversationId] = {
      ...current,
      tabs: normalizeTabs([...current.tabs, { kind: "singleton", id }]),
      activeTabId: current.activeTabId ?? id,
    };
  }
  set({ ...project({ ...state, pinnedTabs, conversations }), pinnedTabs });
  schedulePersist(get);
  rInfo("studio.surface", "surface tab unpinned", {
    surface_tab: id,
    tab_id: currentConversationId ?? "",
  });
},

updateBrowserTab: (id, patch) =>
  updateCurrent(set, get, (current) => ({
    ...current,
    tabs: current.tabs.map((tab) =>
      tab.id === id && tab.kind === "browser" ? { ...tab, ...patch } : tab,
    ),
  })),
renameTerminalTab: (id, title) =>
  updateCurrent(set, get, (current) => ({
    ...current,
    tabs: current.tabs.map((tab) =>
      tab.id === id && tab.kind === "terminal" ? { ...tab, title } : tab,
    ),
  })),

  };
}
