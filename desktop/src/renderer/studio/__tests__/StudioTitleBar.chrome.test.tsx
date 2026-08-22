// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let chromeListener: ((state: { fullScreen: boolean }) => void) | undefined;
const sessionState = {
  activeTabId: "tab-1",
  tabs: [{ id: "tab-1", workingDirectory: "/work/project", title: "Test conversation" }],
  createTabInDirectory: vi.fn(() => Promise.resolve()),
};

vi.mock("../../stores/sessionStore", () => {
  const useSessionStore = (selector: (state: typeof sessionState) => unknown) => selector(sessionState);
  useSessionStore.getState = () => sessionState;
  return { useSessionStore };
});
vi.mock("../../preferences", () => ({
  usePreferencesStore: (selector: (state: { projects: Record<string, never> }) => unknown) => selector({ projects: {} }),
}));
vi.mock("../../theme", () => ({
  useColors: () => ({
    containerBg: "#131316", containerBgCollapsed: "#101013", containerBorder: "#ffffff", textPrimary: "#ffffff", textSecondary: "#cccccc", textTertiary: "#aaaaaa", accent: "#111111", accentLight: "#222222",
  }),
}));
vi.mock("../../components/git/Tooltip", () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../rendererLogger", () => ({ rError: vi.fn(), rWarn: vi.fn() }));
vi.mock("../inbox/ProjectPicker", () => ({ ProjectPicker: () => null }));

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

let root: Root | null = null;
afterEach(() => {
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
    expect(controls).toHaveLength(4);
    const buttons = Array.from(controls);
    // The accessible name is the action alone. The chord is not baked into it:
    // it is resolved live from the keymap and exposed via aria-keyshortcuts,
    // so a rebind cannot leave a stale glyph in the label.
    expect(buttons[0].getAttribute("aria-label")).toBe("Toggle sidebar");
    expect(buttons[2].getAttribute("aria-label")).toBe("Toggle terminal");
    expect(buttons[3].getAttribute("aria-label")).toBe("Toggle canvas panel");
    expect((host.querySelector('[data-testid="studio-title-bar-center"]') as HTMLDivElement).style.flex).toBe("1 1 0%");
    await act(async () => chromeListener?.({ fullScreen: true }));
    expect(titleBar.style.paddingLeft).toBe("12px");

    await act(async () => {
      buttons[0].click();
      buttons[2].click();
      buttons[3].click();
    });
    expect(paneCallbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(paneCallbacks.onToggleTerminal).toHaveBeenCalledOnce();
    expect(paneCallbacks.onToggleSurface).toHaveBeenCalledOnce();
  });
});
