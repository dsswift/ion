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

import { resetSurfaceHydrationForTests, useSurfaceStore } from "../surface-store";

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

describe("surface pane maximized", () => {
  it("starts restored and toggles", () => {
    expect(useSurfaceStore.getState().maximized).toBe(false);
    useSurfaceStore.getState().setVisible(true);
    useSurfaceStore.getState().toggleMaximized();
    expect(useSurfaceStore.getState().maximized).toBe(true);
    useSurfaceStore.getState().toggleMaximized();
    expect(useSurfaceStore.getState().maximized).toBe(false);
  });

  it("maximising a hidden pane shows it", () => {
    expect(useSurfaceStore.getState().visible).toBe(false);
    useSurfaceStore.getState().setMaximized(true);
    expect(useSurfaceStore.getState().visible).toBe(true);
    expect(useSurfaceStore.getState().maximized).toBe(true);
  });

  it("hiding the pane restores it", () => {
    useSurfaceStore.getState().setMaximized(true);
    useSurfaceStore.getState().setVisible(false);
    expect(useSurfaceStore.getState().visible).toBe(false);
    expect(useSurfaceStore.getState().maximized).toBe(false);
  });

  it("is never written to the conversation record", () => {
    useSurfaceStore.getState().setMaximized(true);
    const record = useSurfaceStore.getState().conversations["tab-1"] as unknown as Record<string, unknown> | undefined;
    expect(record === undefined || !("maximized" in record)).toBe(true);
  });
});
