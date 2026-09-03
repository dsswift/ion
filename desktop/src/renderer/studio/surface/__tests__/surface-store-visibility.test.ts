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

describe("surface-store visibility and persistence", () => {
  it("carries live visibility across a switch in keep mode", () => {
    const store = useSurfaceStore.getState();
    store.setVisible(true);
    store.selectConversation("tab-2");
    store.setVisible(false);
    store.selectConversation("tab-1");
    expect(useSurfaceStore.getState().visible).toBe(false);
  });

  it("still records each conversation state in keep mode", () => {
    const store = useSurfaceStore.getState();
    store.setVisible(true);
    store.selectConversation("tab-2");
    store.setVisible(false);
    expect(useSurfaceStore.getState().conversations["tab-1"]?.visible).toBe(
      true,
    );
    expect(useSurfaceStore.getState().conversations["tab-2"]?.visible).toBe(
      false,
    );
  });

  it("restores and saves each conversation visibility in per-conversation mode", () => {
    preferences.studioSurfaceSwitchMode = "per-conversation";
    const store = useSurfaceStore.getState();
    store.setVisible(true);
    store.selectConversation("tab-2");
    expect(useSurfaceStore.getState().visible).toBe(false);
    store.setVisible(true);
    store.selectConversation("tab-1");
    expect(useSurfaceStore.getState().visible).toBe(true);
    expect(useSurfaceStore.getState().conversations["tab-1"]?.visible).toBe(
      true,
    );
    expect(useSurfaceStore.getState().conversations["tab-2"]?.visible).toBe(
      true,
    );
  });

  it("persists an explicitly selected browser session mode", () => {
    const store = useSurfaceStore.getState();
    store.openBrowserTab("https://example.org", "browse");
    const browser = useSurfaceStore
      .getState()
      .tabs.find((tab) => tab.kind === "browser");
    expect(browser).toMatchObject({ sessionMode: "shared" });

    if (!browser || browser.kind !== "browser")
      throw new Error("browser tab missing");
    store.updateBrowserTab(browser.id, { sessionMode: "isolated" });
    expect(
      useSurfaceStore.getState().tabs.find((tab) => tab.id === browser.id),
    ).toMatchObject({ sessionMode: "isolated" });
  });

  it("mounts browser descriptors for inactive conversations", () => {
    const store = useSurfaceStore.getState();
    store.openBrowserTab("https://example.org", "browse");
    store.selectConversation("tab-2");
    store.openBrowserTab("https://example.net", "browse", "shared");
    expect(
      useSurfaceStore.getState().conversations["tab-1"]?.tabs,
    ).toMatchObject([{ kind: "browser" }]);
    expect(
      useSurfaceStore.getState().conversations["tab-2"]?.tabs,
    ).toMatchObject([{ kind: "browser", sessionMode: "shared" }]);
  });

  it("persists v3 records through the studio settings funnel", () => {
    useSurfaceStore.getState().openSingleton("diff");
    vi.advanceTimersByTime(350);
    const [key, value] = setSettingMock.mock.calls[0] as [
      string,
      {
        version: number;
        pinnedTabs: string[];
        conversations: Record<string, unknown>;
      },
    ];
    expect(key).toBe("studioSurface");
    expect(value.version).toBe(4);
    expect(value.pinnedTabs).toEqual(["plan"]);
    expect(value.conversations).toHaveProperty("tab-1");
  });
});
