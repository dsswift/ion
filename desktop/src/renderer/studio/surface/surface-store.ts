import { create } from "zustand";
import { useSessionStore } from "@ion/server/store/sessionStore";
import type { ResourceItem } from "@ion/shared/types-engine";
import {
  browserTabId,
  DISPATCH_SURFACE_ID,
  terminalTabId,
  NOTIFICATION_SURFACE_ID,
  type NotificationTab,
  type PinnableSingletonId,
  type ScratchProject,
  type SingletonId,
  type SurfaceConversationPersisted,
  type SurfaceTab,
} from "@ion/shared/studio-surface-types";
import type {
  BrowserEmulationState,
  StudioBrowserTabInfo,
} from "@ion/shared/studio-browser-types";
import {
  bindAgentBrowserActions,
  pointerAfterOpen,
} from "./surface-agent-browser";
import { openFileTabIn, openPreviewTabIn } from "./surface-file-tabs";
import type { FileReveal, FileRevealTarget } from "./file-reveal";
import {
  applyConversationSelection,
  configureConversationSelection,
} from "./surface-selection";
import {
  configureSurfacePersist,
  flushSurfacePersist,
  scheduleSurfacePersist,
} from "./surface-persist";
import {
  createSurfaceHydrationActions,
  resetSurfaceHydration,
} from "./surface-hydration";

export { flushSurfacePersist };

/** Queue a debounced write of the surface state. */
function schedulePersist(get: () => SurfaceState): void {
  scheduleSurfacePersist(get);
}
import { createQuestionsSurfaceActions } from "./surface-questions-actions";
import { createSurfacePaneActions } from "./surface-pane-actions";
import {
  nextTerminalTitle,
  normalizeTabs,
} from "@ion/shared/studio-surface-ordering";
import { rDebug, rInfo } from "../../rendererLogger";
import { surfaceTabOfferedNow } from "./surface-tab-offer";
import { createRuntimePanelActions } from "./surface-runtime-panel-actions";
import { scratchTabsForProject } from "./surface-scratch";
import { createScratchSurfaceActions } from "./surface-scratch-actions";
import { createSurfaceTabLifecycleActions } from "./surface-tab-lifecycle-actions";
import { materializeFileBuffer } from "./surface-tab-lifecycle";
import {
  emptyConversation,
  normalizeConversation,
  project,
  projectKeyForConversation,
  visibleTabs as visibleSurfaceTabs,
} from "./surface-store-project";

type ConversationMap = Record<string, SurfaceConversationPersisted>;

export interface SurfaceState {
  /** Composed global pins and active conversation descriptors. */
  tabs: SurfaceTab[];
  activeTabId: string | null;
  pinnedTabs: PinnableSingletonId[];
  /** Workspace-scoped notification kept open across every conversation. */
  notification: NotificationTab | null;
  /** Unsaved documents shared by conversations with the same source-project key. */
  scratchProjects: Record<string, ScratchProject>;
  conversations: ConversationMap;
  currentConversationId: string | null;
  /** Dirty Scratch Document waiting for an explicit discard decision. */
  pendingScratchCloseId: string | null;
  /** Current window state. It can intentionally differ from the saved conversation state. */
  visible: boolean;
  /**
   * The projected surface panel width for the current conversation, in px, or
   * null to use the global `studioLayout.surfaceWidth` default. Mirrors
   * `visible`'s current-window/saved-conversation split: this is the value
   * StudioShell renders, `conversations[id].width` is what gets restored on
   * conversation switch (subject to the same studioSurfaceSwitchMode).
   */
  surfaceWidth: number | null;
  hydrated: boolean;
  diffReveal: { filePath: string; staged: boolean; nonce: number } | null;
  /** A pending jump to a line in a file tab; the file tab clears it once applied. */
  fileReveal: FileReveal | null;
  /**
   * Conversation tab ids whose ACTIVE conversation currently has an open
   * guided-questions workflow. The synchronizer (questions-surface-sync)
   * writes this; composition inserts the transient Questions tab for the
   * current conversation when its id is present. Never persisted.
   */
  questionsConversations: Set<string>;
  /**
   * When Questions forced focus, the previously active Canvas tab id per
   * conversation, restored on workflow completion when still valid.
   */
  questionsPriorActive: Record<string, string | null>;

  hydrate(): Promise<void>;
  selectConversation(tabId: string | null): void;
  setVisible(visible: boolean): void;
  toggleVisible(): void;
  /**
   * The pane fills the whole shell, hiding the sidebar and the conversation.
   * Window-local and never persisted: a maximised canvas is a moment of
   * attention, not a layout the operator wants back on relaunch.
   */
  maximized: boolean;
  setMaximized(maximized: boolean): void;
  toggleMaximized(): void;
  /** Commit the surface panel's resized width for the current conversation. */
  setWidth(width: number): void;
  openSingleton(id: SingletonId): void;
  openFileTab(dir: string, tabId: string, filePath: string): void;
  openPreviewTab(filePath: string, dataUrl?: string): void;
  openResourceTab(item: ResourceItem): void;
  openDispatchTab(agentName: string, dispatchId: string, title: string): void;
  openRuntimePanel(id: string, title: string): void;
  updateRuntimePanelTitle(id: string, title: string): void;
  removeRuntimePanel(id: string): void;
  /** Close, through their owners, every runtime panel a conversation holds. */
  closeRuntimePanelsIn(conversationId: string): void;
  createScratch(): void;
  updateScratch(projectKey: string, documentId: string, content: string): void;
  toggleScratchPreview(projectKey: string, documentId: string): void;
  toggleScratchWordWrap(projectKey: string, documentId: string): void;
  setScratchSaveError(
    projectKey: string,
    documentId: string,
    error: string | undefined,
  ): void;
  deleteScratch(projectKey: string, documentId: string): void;
  requestScratchClose(projectKey: string, documentId: string): void;
  cancelScratchClose(): void;
  confirmScratchClose(): void;
  promoteScratch(
    projectKey: string,
    documentId: string,
    filePath: string,
    conversationId: string,
  ): void;
  openBrowserTab(
    url: string,
    mode: "preview" | "browse",
    sessionMode?: "isolated" | "shared",
  ): void;
  /** Move this conversation's agent browser link to an existing browser tab. */
  linkAgentBrowser(instanceId: string): void;
  /**
   * Return a conversation's agent-linked browser tab, creating one when absent.
   *
   * The conversation is always named by the caller and, in the tool path, comes
   * from the engine session key rather than from anything an agent supplies. A
   * background conversation is served exactly like the visible one.
   */
  ensureAgentBrowser(
    conversationId: string,
    url?: string,
  ): StudioBrowserTabInfo | null;
  /** Read a conversation's agent-linked browser tab without creating one. */
  agentBrowser(conversationId: string): StudioBrowserTabInfo | null;
  /** Store (or clear with null) a browser tab's device emulation state. */
  setBrowserEmulation(
    conversationId: string,
    instanceId: string,
    emulation: BrowserEmulationState | null,
  ): void;
  openTerminalTab(cwd: string): void;
  activateTab(id: string): void;
  closeTab(id: string): void;
  closeOthers(id: string): void;
  closeToRight(id: string): void;
  pinTab(id: PinnableSingletonId): void;
  unpinTab(id: PinnableSingletonId): void;
  /**
   * Patch a browser descriptor. `conversationId` names the owner; without it
   * the visible conversation is assumed. A guest in a background conversation
   * reports navigation too, and its descriptor must follow or a restore would
   * reopen the page it left.
   */
  updateBrowserTab(
    id: string,
    patch: Partial<{
      url: string;
      title: string;
      mode: "preview" | "browse";
      sessionMode: "isolated" | "shared";
      zoomLevel: number;
      faviconUrl: string;
    }>,
    conversationId?: string,
  ): void;
  renameTerminalTab(id: string, title: string): void;
  revealDiffFile(target: { filePath: string; staged: boolean }): void;
  /** Open `filePath` as a file tab and select `target` in it once its text loads. */
  revealFileLine(dir: string, tabId: string, filePath: string, target: FileRevealTarget): void;
  /** Clear the pending file reveal, but only if it is still the one applied. */
  consumeFileReveal(nonce: number): void;
  /** Synchronizer entry: a conversation gained an open guided workflow. */
  showQuestionsSurface(tabId: string): void;
  /** Synchronizer entry: a conversation's guided workflows all closed. */
  retireQuestionsSurface(tabId: string): void;
}

export function resetSurfaceHydrationForTests(): void {
  resetSurfaceHydration();
  useSurfaceStore.setState({ hydrated: false });
}

/**
 * Apply an update to a NAMED conversation, on screen or not.
 *
 * An agent acting in a background conversation must be able to open and drive
 * its own browser tab without the operator switching to it. Writing only to
 * the visible conversation would either refuse that work or, worse, apply it
 * to whichever conversation the operator happens to be looking at.
 *
 * `project()` re-derives the visible strip, so an update to a background
 * conversation changes its stored descriptors and leaves the rendered tab list
 * untouched.
 */
export function updateConversationById(
  set: (partial: Partial<SurfaceState>) => void,
  get: () => SurfaceState,
  conversationId: string,
  update: (
    current: SurfaceConversationPersisted,
  ) => SurfaceConversationPersisted,
): void {
  const state = get();
  const current = state.conversations[conversationId] ?? emptyConversation();
  const scratchTabs = scratchTabsForProject(
    state.scratchProjects,
    projectKeyForConversation(conversationId),
  );
  const conversations = {
    ...state.conversations,
    [conversationId]: normalizeConversation(
      state.pinnedTabs,
      state.notification,
      update(current),
      scratchTabs,
    ),
  };
  set({ ...project({ ...state, conversations }), conversations });
  schedulePersist(get);
}

function updateCurrent(
  set: (partial: Partial<SurfaceState>) => void,
  get: () => SurfaceState,
  update: (
    current: SurfaceConversationPersisted,
  ) => SurfaceConversationPersisted,
): void {
  const state = get();
  // Content routes can fire before the Studio sync subscription has observed
  // its first owner tab push. Resolve the live session target here so the
  // route never loses a deliberate open during that short boot interval.
  const id =
    state.currentConversationId ?? useSessionStore.getState().activeTabId;
  if (!id) return;
  const current = state.conversations[id] ?? emptyConversation();
  const scratchTabs = scratchTabsForProject(
    state.scratchProjects,
    projectKeyForConversation(id),
  );
  const conversations = {
    ...state.conversations,
    [id]: normalizeConversation(
      state.pinnedTabs,
      state.notification,
      update(current),
      scratchTabs,
    ),
  };
  set({
    ...project({ ...state, conversations, currentConversationId: id }),
    currentConversationId: id,
  });
  schedulePersist(get);
}

// Selection lives in its own module (size cap); it composes over these two.
// The flush needs the live store, which does not exist until create() runs.
configureSurfacePersist(() => useSurfaceStore.getState());

configureConversationSelection({
  project: (state) => project(state as never) as never,
  emptyConversation,
});

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  pinnedTabs: [],
  notification: null,
  scratchProjects: {},
  conversations: {},
  currentConversationId: null,
  pendingScratchCloseId: null,
  visible: false,
  maximized: false,
  surfaceWidth: null,
  hydrated: false,
  diffReveal: null,
  fileReveal: null,
  questionsConversations: new Set<string>(),
  questionsPriorActive: {},

  ...createSurfaceHydrationActions(set, get, schedulePersist),

  selectConversation: (currentConversationId) => {
    const previous = get().currentConversationId;
    applyConversationSelection(set, get, currentConversationId);
    if (previous && previous !== currentConversationId)
      get().closeRuntimePanelsIn(previous);
  },

  ...createSurfacePaneActions(set, get, updateCurrent),

  openSingleton: (id) => {
    if (!surfaceTabOfferedNow(id)) {
      rInfo("studio.surface", "surface tab not opened: its developer surface is off for this conversation", { surface_tab: id });
      return;
    }
    const state = get();
    if (state.pinnedTabs.includes(id as PinnableSingletonId)) {
      updateCurrent(set, get, (current) => ({ ...current, activeTabId: id }));
      return;
    }
    updateCurrent(set, get, (current) => ({
      ...current,
      tabs: normalizeTabs(
        current.tabs.some((tab) => tab.id === id)
          ? current.tabs
          : [...current.tabs, { kind: "singleton", id }],
      ),
      activeTabId: id,
    }));
  },

  openFileTab: (dir, tabId, filePath) => {
    const resolvedDir = materializeFileBuffer(filePath, dir, tabId);
    if (resolvedDir === null) return;
    updateCurrent(set, get, (current) =>
      openFileTabIn(current, filePath, resolvedDir, tabId),
    );
  },

  openPreviewTab: (filePath, dataUrl) => {
    updateCurrent(set, get, (current) =>
      openPreviewTabIn(current, filePath, dataUrl),
    );
  },

  openResourceTab: (item) => {
    const notification: NotificationTab = {
      kind: "notification",
      id: NOTIFICATION_SURFACE_ID,
      resourceKind: item.kind,
      resourceId: item.id,
      resourceProducer: item.producer,
    };
    const state = get();
    const currentConversationId =
      state.currentConversationId ?? useSessionStore.getState().activeTabId;
    rDebug("studio.surface", "opening workspace notification", {
      resource_id: item.id,
      resource_kind: item.kind,
      tab_id: currentConversationId ?? "",
    });
    if (!currentConversationId) {
      set({ ...project({ ...state, notification }), notification });
      schedulePersist(get);
      rInfo(
        "studio.surface",
        "workspace notification opened without an active conversation",
        {
          resource_id: item.id,
          resource_kind: item.kind,
        },
      );
      return;
    }
    const current =
      state.conversations[currentConversationId] ?? emptyConversation();
    const conversations = {
      ...state.conversations,
      [currentConversationId]: normalizeConversation(
        state.pinnedTabs,
        notification,
        {
          ...current,
          activeTabId: NOTIFICATION_SURFACE_ID,
        },
      ),
    };
    set({
      ...project({
        ...state,
        notification,
        conversations,
        currentConversationId,
      }),
      notification,
      currentConversationId,
    });
    schedulePersist(get);
    rInfo("studio.surface", "workspace notification opened and focused", {
      resource_id: item.id,
      resource_kind: item.kind,
      surface_tab: NOTIFICATION_SURFACE_ID,
      tab_id: currentConversationId,
    });
  },

  openDispatchTab: (agentName, dispatchId, title) =>
    updateCurrent(set, get, (current) => ({
      ...current,
      tabs: current.tabs.some((tab) => tab.id === DISPATCH_SURFACE_ID)
        ? current.tabs.map((tab) =>
            tab.id === DISPATCH_SURFACE_ID
              ? {
                  kind: "dispatch",
                  id: DISPATCH_SURFACE_ID,
                  agentName,
                  dispatchId,
                  title,
                }
              : tab,
          )
        : [
            ...current.tabs,
            {
              kind: "dispatch",
              id: DISPATCH_SURFACE_ID,
              agentName,
              dispatchId,
              title,
            },
          ],
      activeTabId: DISPATCH_SURFACE_ID,
    })),

  ...createRuntimePanelActions({
    set,
    get,
    updateCurrent,
    updateConversation: (conversationId, update) =>
      updateConversationById(set, get, conversationId, update),
  }),

  ...createScratchSurfaceActions({
    set,
    get,
    project,
    schedulePersist,
    emptyConversation,
  }),

  openBrowserTab: (url, mode, sessionMode = "shared") => {
    const instanceId = crypto.randomUUID();
    const id = browserTabId(instanceId);
    updateCurrent(set, get, (current) => {
      // The conversation's first browser tab becomes the agent's tab. Later
      // tabs stay the operator's own — see surface-agent-browser.ts.
      const agentBrowserInstanceId = pointerAfterOpen(current, instanceId);
      return {
        ...current,
        tabs: normalizeTabs(
          [
            ...current.tabs,
            {
              kind: "browser",
              id,
              instanceId,
              url,
              title: url,
              mode,
              sessionMode,
            },
          ],
          agentBrowserInstanceId,
        ),
        activeTabId: id,
        agentBrowserInstanceId,
      };
    });
  },

  ...bindAgentBrowserActions({
    get: () => get(),
    set,
    fallbackConversationId: () => useSessionStore.getState().activeTabId,
    updateConversation: (conversationId, update) =>
      updateConversationById(set, get, conversationId, update),
    normalize: (tabs, agentBrowserInstanceId) =>
      normalizeTabs(tabs, agentBrowserInstanceId),
    info: (message, fields) => rInfo("studio.surface", message, fields),
    debug: (message, fields) => rDebug("studio.surface", message, fields),
  }),

  openTerminalTab: (cwd) => {
    const instanceId = crypto.randomUUID();
    const id = terminalTabId(instanceId);
    updateCurrent(set, get, (current) => ({
      ...current,
      tabs: normalizeTabs([
        ...current.tabs,
        {
          kind: "terminal",
          id,
          instanceId,
          cwd,
          title: nextTerminalTitle(
            visibleSurfaceTabs(get().pinnedTabs, get().notification, current),
          ),
        },
      ]),
      activeTabId: id,
    }));
  },

  ...createSurfaceTabLifecycleActions({
    set,
    get,
    updateCurrent,
    updateConversation: (conversationId, update) =>
      updateConversationById(set, get, conversationId, update),
    schedulePersist,
  }),

  revealDiffFile: ({ filePath, staged }) => {
    get().openSingleton("diff");
    set((state) => ({
      diffReveal: {
        filePath,
        staged,
        nonce: (state.diffReveal?.nonce ?? 0) + 1,
      },
    }));
  },

  revealFileLine: (dir, tabId, filePath, target) => {
    get().openFileTab(dir, tabId, filePath);
    set((state) => ({
      fileReveal: { ...target, filePath, nonce: (state.fileReveal?.nonce ?? 0) + 1 },
    }));
  },

  consumeFileReveal: (nonce) => {
    if (get().fileReveal?.nonce === nonce) set({ fileReveal: null });
  },

  ...createQuestionsSurfaceActions({
    get,
    set,
    project,
    visibleTabs: (pinnedTabs, notification, conversation, tabId) =>
      visibleSurfaceTabs(
        pinnedTabs,
        notification,
        conversation,
        scratchTabsForProject(
          get().scratchProjects,
          projectKeyForConversation(tabId),
        ),
      ),
    emptyConversation,
  }),
}));
