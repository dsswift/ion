import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUDIO_TITLE_BAR_HEIGHT,
  STUDIO_TRAFFIC_LIGHT_POSITION,
} from "../../shared/studio-chrome";

const mocks = vi.hoisted(() => {
  const events = new Map<string, Array<(...args: unknown[]) => void>>();
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 960, height: 640 })),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      events.set(event, [...(events.get(event) ?? []), callback]);
    }),
    once: vi.fn(),
    webContents: {
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
  };
  return { events, window };
});

vi.mock("electron", () => ({
  app: { setActivationPolicy: vi.fn(), dock: { hide: vi.fn() } },
  BrowserWindow: vi.fn(function BrowserWindow() { return mocks.window; }),
}));
vi.mock("../logger", () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }));
vi.mock("../state", () => ({
  enterprisePolicyCache: { policy: null },
  state: { mainWindow: null, studioWindow: null, forceQuit: false },
}));
vi.mock("../settings-store", () => ({ readSettings: () => ({ activeUi: "studio" }), writeSettings: vi.fn() }));
vi.mock("../surface-launch", () => ({ resolveSurfacePlan: () => ({ activeUi: "studio" }) }));
vi.mock("../studio-state-cache", () => ({ getStudioState: vi.fn(() => ({ agents: [] })) }));
vi.mock("../studio-beacon", () => ({ clearBeacon: vi.fn() }));
vi.mock("../deeplink/confirm", () => ({ markDeepLinkConfirmationReady: vi.fn(), markDeepLinkConfirmationUnavailable: vi.fn() }));
vi.mock("../renderer-crash-guard", () => ({ attemptRendererRecovery: vi.fn(), resetRendererCrashGuard: vi.fn() }));
vi.mock("../webview-policy", () => ({ installWebviewPolicy: vi.fn() }));

import { BrowserWindow } from "electron";
import { state } from "../state";
import { openStudioWindow } from "../studio-window-manager";
import { IPC } from "../../shared/types";

beforeEach(() => {
  mocks.events.clear();
  vi.clearAllMocks();
  (state as { studioWindow: unknown }).studioWindow = null;
});

describe("Studio window chrome", () => {
  it("uses hiddenInset title bar and shared traffic-light geometry on macOS", () => {
    openStudioWindow("test");

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: STUDIO_TRAFFIC_LIGHT_POSITION,
    }));
  });

  it("pushes fullscreen changes so renderer removes its traffic-light inset", () => {
    openStudioWindow("test");
    for (const callback of mocks.events.get("enter-full-screen") ?? []) callback();
    for (const callback of mocks.events.get("leave-full-screen") ?? []) callback();

    expect(mocks.window.webContents.send).toHaveBeenNthCalledWith(
      1,
      IPC.STUDIO_WINDOW_CHROME,
      { fullScreen: true },
    );
    expect(mocks.window.webContents.send).toHaveBeenNthCalledWith(
      2,
      IPC.STUDIO_WINDOW_CHROME,
      { fullScreen: false },
    );
  });

  it("uses shared title bar height for non-macOS control overlays", () => {
    expect(STUDIO_TITLE_BAR_HEIGHT).toBe(38);
  });
});
