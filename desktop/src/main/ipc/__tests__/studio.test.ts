/**
 * Studio IPC handler validation: every renderer-supplied payload is checked
 * before any side effect, per the ipc-validation conventions. Handlers are
 * captured from a mocked ipcMain and invoked directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  handlers,
  onHandlers,
  writeSettingsMock,
  openStudioWindowMock,
  applyStudioActivationPolicyMock,
  setStudioTitleBarOverlayMock,
  broadcastMock,
  studioSendMock,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  writeSettingsMock: vi.fn(),
  openStudioWindowMock: vi.fn(),
  applyStudioActivationPolicyMock: vi.fn(),
  setStudioTitleBarOverlayMock: vi.fn(() => true),
  broadcastMock: vi.fn(),
  studioSendMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {},
  session: {
    fromPartition: vi.fn(() => ({ webRequest: { onBeforeRequest: vi.fn() } })),
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    ),
    on: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) =>
      onHandlers.set(channel, fn),
    ),
  },
}));
vi.mock("../../logger", () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../broadcast', () => ({ broadcast: broadcastMock }));
vi.mock("@ion/server/state", async (importOriginal) => ({ ...(await importOriginal()), ...{
  state: {
    studioActiveTabId: "active-tab",
    studioActiveProfileId: null,
    mainWindow: {
      isDestroyed: () => false,
      webContents: { id: 1 },
    },
    studioWindow: {
      isDestroyed: () => false,
      webContents: { send: studioSendMock },
    },
  },
  enterprisePolicyCache: { policy: null },
} }));
vi.mock("../../studio-window-manager", () => ({
  openStudioWindow: openStudioWindowMock,
  applyStudioActivationPolicy: applyStudioActivationPolicyMock,
  isStudioWindowOpen: vi.fn(() => true),
  setStudioTitleBarOverlay: setStudioTitleBarOverlayMock,
}));
vi.mock("@ion/server/engine/studio-state-cache", () => ({
  getStudioState: vi.fn(() => ({ agents: [], events: [], statusFields: null })),
}));
vi.mock("@ion/server/persistence/settings-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ion/server/persistence/settings-store")>();
  return {
    ...actual,
    readSettings: vi.fn(() => ({ studioTheme: "ion-works" })),
    writeSettings: writeSettingsMock,
    SETTINGS_DEFAULTS: {
      studioTheme: "ion-works",
      studioZoom: 2,
      studioSeeds: {},
    },
  };
});

import { registerStudioIpc } from "../studio";
import { IPC } from "@ion/shared/types";

registerStudioIpc();

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args);
}

beforeEach(() => {
  writeSettingsMock.mockClear();
  applyStudioActivationPolicyMock.mockClear();
  setStudioTitleBarOverlayMock.mockClear();
  broadcastMock.mockClear();
  studioSendMock.mockClear();
});

describe("studio:set-title-bar-overlay validation", () => {
  it("rejects malformed colors before touching native window chrome", () => {
    expect(invoke(IPC.STUDIO_SET_TITLE_BAR_OVERLAY, "not-a-color", "#ffffff")).toBe(false);
    expect(setStudioTitleBarOverlayMock).not.toHaveBeenCalled();
  });

  it("passes two opaque hex colors to native window chrome", () => {
    expect(invoke(IPC.STUDIO_SET_TITLE_BAR_OVERLAY, "#101013", "#f5f5f5")).toBe(true);
    expect(setStudioTitleBarOverlayMock).toHaveBeenCalledWith("#101013", "#f5f5f5");
  });
});
