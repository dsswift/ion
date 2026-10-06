// @vitest-environment jsdom
/**
 * InputBar behavior that must survive the move from a textarea to the
 * CodeMirror editor: per-tab drafts, `!` bash mode, and the slash menu.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const clearPendingInput = vi.fn();
  const setDraftInput = vi.fn();
  const storeState = {
    activeTabId: "tab-rewind",
    tabsReady: true,
    initProgress: "",
    tabs: [
      {
        id: "tab-rewind",
        status: "idle",
        attachments: [],
        pendingInput: undefined as string | undefined,
        workingDirectory: "/workspace",
        bashExecuting: false,
      },
    ],
    conversationPanes: new Map([
      ["tab-b", { activeInstanceId: "main", instances: [{ id: "main", draftInput: "draft for b" }] }],
      [
        "tab-rewind",
        {
          activeInstanceId: "main",
          instances: [
            {
              id: "main",
              draftInput: "",
            },
          ],
        },
      ],
    ]),
    submit: vi.fn(),
    startBashCommand: vi.fn(),
    completeBashCommand: vi.fn(),
    addAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    setDraftInput,
    clearPendingInput,
    createTab: vi.fn(async () => "tab-new"),
  };
  const useSessionStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  );
  return { clearPendingInput, setDraftInput, storeState, useSessionStore };
});

const colors = {
  textPrimary: "black",
  textTertiary: "gray",
  containerBorder: "silver",
  sendDisabled: "gray",
  sendHover: "green",
  accentPressed: "purple",
  sendPressed: "purple",
  sendBg: "blue",
  textOnAccent: "white",
  sendFg: "white",
} as never;

vi.mock("@ion/server/store/sessionStore", () => ({
  useSessionStore: h.useSessionStore,
}));
// The mock must expose every selector InputBar reads, not just the ones this
// test asserts on: a selector that resolves to undefined is called as a
// function by the component and throws before the rewind behavior under test
// ever renders.
vi.mock("@ion/server/store/model-store", () => ({
  useModelStore: (
    selector: (state: {
      findModelIn: () => undefined;
      isModelCliServedIn: () => boolean;
    }) => unknown,
  ) => selector({ findModelIn: () => undefined, isModelCliServedIn: () => false }),
}));
vi.mock("../../preferences", () => ({
  usePreferencesStore: (
    selector: (state: {
      bashCommandEntry: boolean;
      preferredModel: null;
    }) => unknown,
  ) => selector({ bashCommandEntry: true, preferredModel: null }),
}));
const hostShell = vi.hoisted(() => ({
  discoverCommands: vi.fn(async () => []),
  onWindowShown: vi.fn(() => () => {}),
  searchFiles: vi.fn(async () => ({ files: ["src/alpha.ts", "src/beta.ts"], source: "git", truncated: false })),
  attachFileByPath: vi.fn(async (_tabId: string, path: string) => ({ id: `att:${path}`, type: "file", name: "alpha.ts", path })),
}));
vi.mock("../../host/host-instance", () => ({ host: { capabilities: () => ["windowShown"], shell: hostShell } }));
vi.mock("../PopoverLayer", () => ({ usePopoverLayer: () => document.body }));
vi.mock("../../hooks/useViewportClamp", () => ({ useViewportClamp: () => undefined }));
vi.mock("../../viewport-zoom", () => ({
  zoomRect: (r: DOMRect) => r,
  zoomViewport: () => ({ width: 1000, height: 800 }),
}));
vi.mock("../../theme", () => ({ useColors: () => colors }));
vi.mock("../../hooks/useActiveContextCapacity", () => ({
  useActiveContextCapacity: () => ({
    capacityLimit: 0,
    state: "normal",
    tokens: 0,
  }),
}));
vi.mock("../../rendererLogger", () => ({
  rDebug: vi.fn(),
  rError: vi.fn(),
  rWarn: vi.fn(),
}));
vi.mock("@ion/server/store/slices/engine-event-slice", () => ({
  getRendererExtensionCommands: () => [],
}));
vi.mock("../InputBarVoiceButton", () => ({
  useVoiceRecording: () => ({
    voiceState: "idle",
    voiceError: null,
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    toggleRecording: vi.fn(),
  }),
  VoiceButtons: () => null,
}));
vi.mock("../InputBarSendButton", () => ({ SendButton: () => null }));
vi.mock("../UpdateButton", () => ({ UpdateButton: () => null }));
vi.mock("../InputBarSend", () => ({
  dispatchSend: vi.fn(() => ({ accepted: false })),
}));
vi.mock("../InputBarBash", () => ({ dispatchBashCommand: vi.fn() }));
// The stash reads Environment settings over the host wire, which this test
// does not stand up; its own behavior is pinned in useComposerStash.test.tsx.
vi.mock("../composer/useComposerStash", () => ({
  useComposerStash: () => ({ entries: [], handleKeyDown: () => false, restore: () => undefined, remove: () => undefined }),
}));
vi.mock("../ComposerControls", () => ({ ComposerControls: () => null }));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: { div: ({ children, initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => <div {...rest}>{children}</div> },
}));
vi.mock("../AttachmentChips", () => ({ AttachmentChips: () => null }));
vi.mock("../SlashCommandMenu", () => ({
  SlashCommandMenu: ({ filter }: { filter: string }) => <div data-testid="slash-menu">{filter}</div>,
  getFilteredCommandsWithExtras: () => [],
  slashMenuEnterAction: () => "submit",
  slashMenuPlacement: () => ({ bottom: 10, left: 10, right: 10 }),
  ExtensionCommandIcon: () => null,
}));
vi.mock("../InputLockNotice", () => ({ InputLockNotice: () => null }));
vi.mock("../ContextCapacityNotice", () => ({
  ContextCapacityNotice: () => null,
}));
vi.mock("../ImageModelNotice", () => ({ ImageModelNotice: () => null }));

import { EditorView } from "@codemirror/view";
import { InputBar, useBashModeStore } from "../InputBar";
import { useEnvironmentSettingsStore } from "../../studio/state/environment-settings-store";
import { LOCAL_ENVIRONMENT_ID } from "@ion/shared/types-environments";

describe("InputBar on the CodeMirror editor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function mount(): Promise<EditorView> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<InputBar />); });
    return EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  }
  const type = (view: EditorView, text: string): void =>
    act(() => view.dispatch(view.state.replaceSelection(text)));
  const key = (view: EditorView, init: KeyboardEventInit): void =>
    act(() => { view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

  // A full-view connection: the server granted it the terminal scope, so `!` enters bash mode.
  beforeEach(() => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ["conversations:read", "conversations:operate", "terminal:operate"]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    h.storeState.activeTabId = "tab-rewind";
    h.setDraftInput.mockClear();
    act(() => useBashModeStore.getState().set(false));
  });

  it("saves the departing tab's text and restores the arriving tab's draft", async () => {
    const view = await mount();
    type(view, "half a thought");
    h.storeState.activeTabId = "tab-b";
    await act(async () => { root.render(<InputBar />); });
    expect(h.setDraftInput).toHaveBeenCalledWith("tab-rewind", "half a thought");
    expect(view.state.doc.toString()).toBe("draft for b");
  });

  it("enters bash mode on a leading ! with the text left empty, and Backspace on empty exits", async () => {
    const view = await mount();
    type(view, "!");
    expect(useBashModeStore.getState().active).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    key(view, { key: "Backspace" });
    expect(useBashModeStore.getState().active).toBe(false);
  });

  it("offers project files on @, inserts the pick as a chip, and sends the file along", async () => {
    const { dispatchSend } = await import("../InputBarSend");
    const view = await mount();
    type(view, "see @al");
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(hostShell.searchFiles).toHaveBeenLastCalledWith("/workspace", "al", expect.any(Number));
    expect(document.querySelector('[data-testid="composer-mention-menu"]')?.textContent).toContain("alpha.ts");

    key(view, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("see @src/alpha.ts ");
    expect(container.querySelector('[data-composer-chip="file"]')?.textContent).toBe("alpha.ts");
    expect(dispatchSend).not.toHaveBeenCalled();

    key(view, { key: "Enter" });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(hostShell.attachFileByPath).toHaveBeenCalledWith("tab-rewind", "/workspace/src/alpha.ts");
    expect(h.storeState.addAttachments).toHaveBeenCalledWith([expect.objectContaining({ path: "/workspace/src/alpha.ts" })]);
    expect(dispatchSend).toHaveBeenCalledWith("see @src/alpha.ts", 1, expect.anything());
  });

  it("opens the slash menu on a leading / and closes it on Escape", async () => {
    const view = await mount();
    type(view, "/cl");
    expect(container.querySelector('[data-testid="slash-menu"]')?.textContent).toBe("/cl");
    key(view, { key: "Escape" });
    expect(container.querySelector('[data-testid="slash-menu"]')).toBeNull();
  });
});
