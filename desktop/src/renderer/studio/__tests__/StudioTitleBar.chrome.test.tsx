// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let chromeListener: ((state: { fullScreen: boolean }) => void) | undefined;
const sessionState = {
  activeTabId: "tab-1",
  tabs: [{ id: "tab-1", workingDirectory: "/work/project", title: "Test conversation" }],
  createTabInDirectory: vi.fn(() => Promise.resolve()),
};

vi.mock("@ion/server/store/sessionStore", () => {
  const useSessionStore = (selector: (state: typeof sessionState) => unknown) => selector(sessionState);
  useSessionStore.getState = () => sessionState;
  return { useSessionStore };
});
const preferences = { projects: {} as Record<string, never>, enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string } };
vi.mock("../../preferences", () => ({
  usePreferencesStore: (selector: (state: typeof preferences) => unknown) => selector(preferences),
}));
vi.mock("../../theme", () => ({
  useColors: () => ({
    containerBg: "#131316", containerBgCollapsed: "#101013", containerBorder: "#ffffff", textPrimary: "#ffffff", textSecondary: "#cccccc", textTertiary: "#aaaaaa", accent: "#111111", accentLight: "#222222",
  }),
}));
vi.mock("../../components/git/Tooltip", () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../components/NotificationsPanel", () => ({ NotificationsBell: () => <button aria-label="Notifications" /> }));
vi.mock("../../components/DirectoryPicker", () => ({ DirectoryPicker: () => <div data-testid="directory-picker" /> }));
vi.mock("../../rendererLogger", () => ({ rDebug: vi.fn(), rError: vi.fn(), rWarn: vi.fn() }));

Object.defineProperty(window, "ion", {
  value: {
    platform: "darwin",
    onStudioWindowChrome: (callback: (state: { fullScreen: boolean }) => void) => {
      chromeListener = callback;
      return () => { chromeListener = undefined; };
    },
    studioSetTitleBarOverlay: vi.fn(() => Promise.resolve(true)),
  },
  configurable: true,
});

import { StudioTitleBar } from "../StudioTitleBar";
import { useEnvironmentSettingsStore } from "../state/environment-settings-store";
import { LOCAL_ENVIRONMENT_ID } from "@ion/shared/types-environments";

const FULL_VIEW = ["conversations:read", "conversations:operate", "terminal:operate", "git:write"] as const;
const CHAT_ONLY = ["conversations:read", "conversations:operate"] as const;

let root: Root | null = null;
beforeEach(() => {
  useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, FULL_VIEW);
});
afterEach(() => {
  preferences.enterpriseNewConversationDefaults = null;
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("StudioTitleBar native chrome", () => {
  it("reserves traffic-light space, keeps controls interactive, and removes inset in fullscreen", async () => {
    const paneCallbacks = {
      onToggleSidebar: vi.fn(), onToggleTerminal: vi.fn(), onToggleSurface: vi.fn(),
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<StudioTitleBar panes={{ leftSidebarVisible: true, leftSidebarWidth: 440, terminalVisible: false, surfaceVisible: false, ...paneCallbacks }} />);
    });

    const titleBar = host.querySelector('[data-testid="studio-title-bar"]') as HTMLDivElement;
    expect(titleBar.dataset.dragRegion).toBe("drag");
    expect(titleBar.style.paddingLeft).toBe("90px");
    expect(host.textContent).toContain("Ion Studio");
    const controls = host.querySelectorAll("button");
    expect(controls).toHaveLength(5);
    const buttons = Array.from(controls);
    // The accessible name is the action alone. The chord is not baked into it:
    // it is resolved live from the keymap and exposed via aria-keyshortcuts,
    // so a rebind cannot leave a stale glyph in the label.
    expect(buttons[0].getAttribute("aria-label")).toBe("Toggle sidebar");
    expect(buttons[3].getAttribute("aria-label")).toBe("Toggle terminal");
    expect(buttons[4].getAttribute("aria-label")).toBe("Toggle canvas panel");
    expect((host.querySelector('[data-testid="studio-title-bar-center"]') as HTMLDivElement).style.flex).toBe("1 1 0%");
    await act(async () => chromeListener?.({ fullScreen: true }));
    expect(titleBar.style.paddingLeft).toBe("12px");

    await act(async () => {
      buttons[0].click();
      buttons[3].click();
      buttons[4].click();
    });
    expect(paneCallbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(paneCallbacks.onToggleTerminal).toHaveBeenCalledOnce();
    expect(paneCallbacks.onToggleSurface).toHaveBeenCalledOnce();

    await act(async () => {
      // macOS turns Control-click into a context click and can strip ctrlKey
      // from the final click. Reproduce the native sequence: modified mousedown,
      // contextmenu, then an unmodified synthetic click.
      buttons[3].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, ctrlKey: true, altKey: true }));
      buttons[3].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ctrlKey: true, altKey: true }));
      buttons[3].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    });
    expect(paneCallbacks.onToggleTerminal).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="directory-picker"]')).not.toBeNull();
  });

  it("renders no terminal toggle for a connection without terminal:operate, and keeps every other control", async () => {
    useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, CHAT_ONLY);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<StudioTitleBar panes={{ leftSidebarVisible: true, leftSidebarWidth: 440, terminalVisible: false, surfaceVisible: false, onToggleSidebar: vi.fn(), onToggleTerminal: vi.fn(), onToggleSurface: vi.fn() }} />);
    });
    const labels = Array.from(host.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    expect(labels).not.toContain("Toggle terminal");
    expect(labels).toContain("Toggle sidebar");
    expect(labels).toContain("Toggle canvas panel");
  });
});

describe("StudioTitleBar project breadcrumb", () => {
  async function renderBar(): Promise<HTMLDivElement> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<StudioTitleBar panes={{ leftSidebarVisible: false, leftSidebarWidth: 0, terminalVisible: false, surfaceVisible: false, onToggleSidebar: vi.fn(), onToggleTerminal: vi.fn(), onToggleSurface: vi.fn() }} />);
    });
    return host;
  }

  it("is a button that opens the new-conversation picker when nothing locks the folder", async () => {
    const host = await renderBar();
    expect(host.querySelector('button[aria-label="Start a new conversation"]')).not.toBeNull();
  });

  it("is a plain label, with no picker to open, under a directory lock", async () => {
    preferences.enterpriseNewConversationDefaults = { locked: true, baseDirectory: "/work/project", engineProfileId: "orion" };
    const host = await renderBar();
    expect(host.querySelector('button[aria-label="Start a new conversation"]')).toBeNull();
    expect(host.querySelector('[data-testid="studio-title-bar-project"]')?.textContent).toContain("project");
  });
});
