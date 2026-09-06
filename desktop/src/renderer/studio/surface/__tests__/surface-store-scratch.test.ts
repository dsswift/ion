// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openFileInEditorMock = vi.fn();
const fileEditorStates = new Map<
  string,
  { files: Array<{ fileName: string }> }
>();
const sessionTabs: Array<{
  id: string;
  workingDirectory: string;
  worktree?: { repoPath: string };
}> = [];
let activeSessionTabId: string | null = "tab-1";
vi.mock("../../../stores/sessionStore", () => ({
  useSessionStore: {
    getState: () => ({
      openFileInEditor: openFileInEditorMock,
      fileEditorStates,
      tabs: sessionTabs,
      activeTabId: activeSessionTabId,
    }),
  },
}));
vi.mock("../../../stores/session-store-helpers", () => ({
  editorDirForTab: (tab: {
    worktree?: { repoPath: string };
    workingDirectory: string;
  }) => tab.worktree?.repoPath ?? tab.workingDirectory,
  nextUntitledNameFromNames: (names: Iterable<string>) => {
    const used = new Set(names);
    let number = 1;
    while (used.has(`Untitled-${number}.md`)) number++;
    return `Untitled-${number}.md`;
  },
}));
const preferences = {
  studioSurfaceSwitchMode: "preserve" as "preserve" | "per-conversation",
  editorWordWrap: true,
};
vi.mock("../../../preferences", () => ({
  usePreferencesStore: { getState: () => preferences },
}));

import {
  flushSurfacePersist,
  resetSurfaceHydrationForTests,
  useSurfaceStore,
} from "../surface-store";

const terminalDestroyMock = vi.fn().mockResolvedValue(undefined);
const setSettingMock = vi.fn().mockResolvedValue(true);
const getSettingsMock = vi.fn().mockResolvedValue({});

function resetStore(): void {
  resetSurfaceHydrationForTests();
  useSurfaceStore.setState({
    tabs: [],
    activeTabId: null,
    pinnedTabs: ["plan"],
    notification: null,
    scratchProjects: {},
    conversations: {},
    currentConversationId: "tab-1",
    pendingScratchCloseId: null,
    visible: false,
    surfaceWidth: null,
    hydrated: true,
    diffReveal: null,
  });
  useSurfaceStore.getState().selectConversation(null);
  useSurfaceStore.getState().selectConversation("tab-1");
}

beforeEach(() => {
  vi.useFakeTimers();
  openFileInEditorMock.mockClear();
  terminalDestroyMock.mockClear();
  setSettingMock.mockClear();
  preferences.studioSurfaceSwitchMode = "preserve";
  preferences.editorWordWrap = true;
  activeSessionTabId = "tab-1";
  sessionTabs.length = 0;
  sessionTabs.push(
    { id: "tab-1", workingDirectory: "/repo" },
    { id: "tab-2", workingDirectory: "/other" },
  );
  (window as unknown as { ion: unknown }).ion = {
    terminalDestroy: terminalDestroyMock,
    studioSetSetting: setSettingMock,
    studioGetSettings: getSettingsMock,
  };
  resetStore();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("surface-store scratch documents", () => {
  it("shares Scratch Documents across a source checkout and its worktrees", () => {
    sessionTabs.splice(
      0,
      sessionTabs.length,
      { id: "source", workingDirectory: "/repo" },
      {
        id: "worktree-a",
        workingDirectory: "/worktrees/a",
        worktree: { repoPath: "/repo" },
      },
      {
        id: "worktree-b",
        workingDirectory: "/worktrees/b",
        worktree: { repoPath: "/repo" },
      },
      { id: "other", workingDirectory: "/other" },
    );
    activeSessionTabId = "worktree-a";
    useSurfaceStore.getState().selectConversation("worktree-a");
    useSurfaceStore.getState().createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch");
    expect(scratch).toMatchObject({
      projectKey: "/repo",
      fileName: "Untitled-1.md",
    });
    expect(setSettingMock).not.toHaveBeenCalled();

    flushSurfacePersist();

    expect(setSettingMock).toHaveBeenCalledWith(
      "studioSurface",
      expect.objectContaining({
        version: 4,
        scratchProjects: expect.objectContaining({
          "/repo": expect.any(Object),
        }),
      }),
    );

    useSurfaceStore.getState().selectConversation("source");
    expect(
      useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch?.id),
    ).toBe(true);
    useSurfaceStore.getState().selectConversation("worktree-b");
    expect(
      useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch?.id),
    ).toBe(true);
    useSurfaceStore.getState().selectConversation("other");
    expect(
      useSurfaceStore.getState().tabs.some((tab) => tab.kind === "scratch"),
    ).toBe(false);
  });

  it("reads the same content from every source-project conversation", () => {
    sessionTabs.splice(
      0,
      sessionTabs.length,
      { id: "source", workingDirectory: "/repo" },
      {
        id: "worktree-a",
        workingDirectory: "/worktrees/a",
        worktree: { repoPath: "/repo" },
      },
    );
    activeSessionTabId = "source";
    useSurfaceStore.getState().selectConversation("source");
    useSurfaceStore.getState().createScratch();
    const created = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;
    if (created.kind !== "scratch") throw new Error("scratch tab missing");
    useSurfaceStore
      .getState()
      .updateScratch(created.projectKey, created.documentId, "shared body");

    // The reader is the surface tab a sibling conversation composes for itself:
    // its projectKey is what ScratchSurface passes to look the document up.
    activeSessionTabId = "worktree-a";
    useSurfaceStore.getState().selectConversation("worktree-a");
    const sibling = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;
    if (sibling.kind !== "scratch")
      throw new Error("sibling scratch tab missing");
    const document = useSurfaceStore
      .getState()
      .scratchProjects[sibling.projectKey]?.documents.find(
        (doc) => doc.id === sibling.documentId,
      );
    expect(document?.content).toBe("shared body");
  });

  it("re-activates a Scratch tab after another tab was visited", () => {
    const store = useSurfaceStore.getState();
    store.createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;
    expect(useSurfaceStore.getState().activeTabId).toBe(scratch.id);

    // Move focus off the scratch tab, then click back onto it. Scratch tabs
    // live in the global scratchProjects map, not conversation.tabs, so the
    // activation guard has to compose them in — before the fix this was a
    // no-op and the active tab stayed on 'plan'.
    store.openSingleton("plan");
    expect(useSurfaceStore.getState().activeTabId).toBe("plan");
    store.activateTab(scratch.id);
    expect(useSurfaceStore.getState().activeTabId).toBe(scratch.id);
  });

  it("activates a Scratch tab from another conversation in the same project", () => {
    sessionTabs.splice(
      0,
      sessionTabs.length,
      { id: "source", workingDirectory: "/repo" },
      {
        id: "worktree-a",
        workingDirectory: "/worktrees/a",
        worktree: { repoPath: "/repo" },
      },
    );
    activeSessionTabId = "source";
    const store = useSurfaceStore.getState();
    store.selectConversation("source");
    store.createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;

    store.selectConversation("worktree-a");
    // The shared scratch tab is visible here; clicking it must activate it.
    expect(
      useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch.id),
    ).toBe(true);
    store.activateTab(scratch.id);
    expect(useSurfaceStore.getState().activeTabId).toBe(scratch.id);
  });

  it("keeps a Scratch Document after its creating conversation disappears", () => {
    useSurfaceStore.getState().createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch");
    sessionTabs.splice(0, 1);
    activeSessionTabId = "tab-2";
    sessionTabs[0]!.workingDirectory = "/repo";
    useSurfaceStore.getState().selectConversation("tab-2");

    expect(
      useSurfaceStore.getState().tabs.some((tab) => tab.id === scratch?.id),
    ).toBe(true);
  });

  it("requires confirmation before discarding a dirty Scratch Document", () => {
    useSurfaceStore.getState().createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;
    if (scratch.kind !== "scratch") throw new Error("scratch tab missing");
    useSurfaceStore
      .getState()
      .updateScratch(scratch.projectKey, scratch.documentId, "keep me");

    useSurfaceStore.getState().closeTab(scratch.id);
    expect(useSurfaceStore.getState().pendingScratchCloseId).toBe(
      scratch.documentId,
    );
    expect(
      useSurfaceStore.getState().scratchProjects[scratch.projectKey]?.documents,
    ).toHaveLength(1);

    useSurfaceStore.getState().confirmScratchClose();
    expect(
      useSurfaceStore.getState().scratchProjects[scratch.projectKey],
    ).toBeUndefined();
  });

  it("promotes a Scratch Document into only the active conversation", () => {
    useSurfaceStore.getState().createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;
    if (scratch.kind !== "scratch") throw new Error("scratch tab missing");

    useSurfaceStore
      .getState()
      .promoteScratch(
        scratch.projectKey,
        scratch.documentId,
        "/repo/notes.md",
        "tab-1",
      );

    expect(
      useSurfaceStore.getState().scratchProjects[scratch.projectKey],
    ).toBeUndefined();
    expect(openFileInEditorMock).toHaveBeenCalledWith(
      "/repo",
      "tab-1",
      "/repo/notes.md",
    );
    expect(
      useSurfaceStore.getState().conversations["tab-1"]?.tabs,
    ).toContainEqual(
      expect.objectContaining({ kind: "file", filePath: "/repo/notes.md" }),
    );
    expect(
      useSurfaceStore.getState().conversations["tab-2"]?.tabs ?? [],
    ).not.toContainEqual(
      expect.objectContaining({ filePath: "/repo/notes.md" }),
    );
  });

  it("keeps the save target fixed if the active conversation changes during Save", () => {
    sessionTabs[1]!.workingDirectory = "/repo";
    useSurfaceStore.getState().createScratch();
    const scratch = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "scratch")!;
    if (scratch.kind !== "scratch") throw new Error("scratch tab missing");
    useSurfaceStore.getState().selectConversation("tab-2");

    useSurfaceStore
      .getState()
      .promoteScratch(
        scratch.projectKey,
        scratch.documentId,
        "/repo/notes.md",
        "tab-1",
      );

    expect(openFileInEditorMock).toHaveBeenCalledWith(
      "/repo",
      "tab-1",
      "/repo/notes.md",
    );
    expect(
      useSurfaceStore.getState().conversations["tab-1"]?.tabs,
    ).toContainEqual(expect.objectContaining({ filePath: "/repo/notes.md" }));
    expect(
      useSurfaceStore.getState().conversations["tab-2"]?.tabs ?? [],
    ).not.toContainEqual(
      expect.objectContaining({ filePath: "/repo/notes.md" }),
    );
  });
});
