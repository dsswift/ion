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
vi.mock("../../state", () => ({
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
}));
vi.mock("../../studio-window-manager", () => ({
  openStudioWindow: openStudioWindowMock,
  applyStudioActivationPolicy: applyStudioActivationPolicyMock,
  isStudioWindowOpen: vi.fn(() => true),
  setStudioTitleBarOverlay: setStudioTitleBarOverlayMock,
}));
vi.mock("../../studio-state-cache", () => ({
  getStudioState: vi.fn(() => ({ agents: [], events: [], statusFields: null })),
}));
vi.mock("../../studio-theme-packs", () => ({
  listThemePacks: vi.fn(() => []),
  readPackBundle: vi.fn(() => null),
  readThemeAsset: vi.fn(() => null),
}));
vi.mock("../../settings-store", () => ({
  readSettings: vi.fn(() => ({ studioTheme: "ion-works" })),
  writeSettings: writeSettingsMock,
  SETTINGS_DEFAULTS: {
    studioTheme: "ion-works",
    studioZoom: 2,
    studioSeeds: {},
  },
}));

import { registerStudioIpc } from "../studio";
import { IPC } from "../../../shared/types";
import { readSettings } from "../../settings-store";

registerStudioIpc();

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args);
}

function ownerEvent(senderId = 1): { sender: { id: number } } {
  return { sender: { id: senderId } };
}

beforeEach(() => {
  writeSettingsMock.mockClear();
  applyStudioActivationPolicyMock.mockClear();
  setStudioTitleBarOverlayMock.mockClear();
  broadcastMock.mockClear();
  studioSendMock.mockClear();
});

describe("studio:tabs-sync owner validation", () => {
  const snapshot = { tabs: [], activeSessionId: null };

  it("accepts only the Overlay owner and pushes the main-assigned revision", () => {
    const publish = onHandlers.get(IPC.STUDIO_PUBLISH_TABS_SYNC)!;
    publish(ownerEvent(), snapshot);

    expect(broadcastMock).toHaveBeenCalledWith(
      IPC.STUDIO_TABS_SYNC,
      expect.objectContaining({ ...snapshot, revision: expect.any(Number) }),
    );
  });

  it("rejects a non-owner publisher", () => {
    const publish = onHandlers.get(IPC.STUDIO_PUBLISH_TABS_SYNC)!;
    publish(ownerEvent(2), snapshot);

    expect(studioSendMock).not.toHaveBeenCalled();
  });
});

describe("studio:get-state validation", () => {
  it("serves the active tab when no tabId is passed", () => {
    const result = invoke(IPC.STUDIO_GET_STATE) as { activeTabId: string };
    expect(result.activeTabId).toBe("active-tab");
  });

  it("rejects malformed tab ids", () => {
    expect(invoke(IPC.STUDIO_GET_STATE, "../etc/passwd")).toBeNull();
    expect(invoke(IPC.STUDIO_GET_STATE, "tab id with spaces")).toBeNull();
    expect(invoke(IPC.STUDIO_GET_STATE, 42 as unknown as string)).toBeNull();
  });
});

describe("studio:set-setting validation", () => {
  it("rejects keys outside the Studio window allowlist", () => {
    expect(invoke(IPC.STUDIO_SET_SETTING, "relayApiKey", "steal")).toBe(false);
    expect(invoke(IPC.STUDIO_SET_SETTING, "themeMode", "light")).toBe(false);
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it("validates per-key value shapes", () => {
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioZoom", 2.5)).toBe(false);
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioZoom", 99)).toBe(false);
    // studioPinned retired with the always-on-top machinery: the key is no
    // longer in the allowlist at all.
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioPinned", true)).toBe(false);
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioTheme", "Bad Theme!")).toBe(
      false,
    );
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioSeed", 42)).toBe(false);
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioSeed", "x".repeat(300))).toBe(
      false,
    );
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it("persists valid values", () => {
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioZoom", 0)).toBe(true); // fit mode
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioZoom", 3)).toBe(true);
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioSeed", "my-office")).toBe(
      true,
    );
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioSeed", "")).toBe(true); // reset to default
    expect(writeSettingsMock).toHaveBeenCalledTimes(4);
  });

  it("studioLayout: accepts every complete normalized layout the shell can persist", () => {
    for (const view of ["inbox", "explorer", "git"]) {
      const layout = {
        leftSidebarVisible: true,
        leftSidebarView: view,
        surfaceWidth: 520,
        terminalHeight: 240,
        dispatchSplitRatio: 0.45,
      };
      expect(invoke(IPC.STUDIO_SET_SETTING, "studioLayout", layout)).toBe(true);
    }
  });

  it("studioLayout: rejects out-of-bounds sizes, bad views, and partial shapes", () => {
    const good = {
      leftSidebarVisible: false,
      leftSidebarView: "explorer",
      surfaceWidth: 520,
      terminalHeight: 240,
      dispatchSplitRatio: 0.45,
    };
    expect(
      invoke(IPC.STUDIO_SET_SETTING, "studioLayout", {
        ...good,
        surfaceWidth: 10,
      }),
    ).toBe(false);
    expect(
      invoke(IPC.STUDIO_SET_SETTING, "studioLayout", {
        ...good,
        terminalHeight: 9999,
      }),
    ).toBe(false);
    expect(
      invoke(IPC.STUDIO_SET_SETTING, "studioLayout", {
        ...good,
        dispatchSplitRatio: 0.05,
      }),
    ).toBe(false);
    expect(
      invoke(IPC.STUDIO_SET_SETTING, "studioLayout", {
        ...good,
        leftSidebarView: "bogus",
      }),
    ).toBe(false);
    expect(
      invoke(IPC.STUDIO_SET_SETTING, "studioLayout", {
        leftSidebarVisible: true,
      }),
    ).toBe(false); // partial
    expect(
      invoke(IPC.STUDIO_SET_SETTING, "studioLayout", { ...good, extraKey: 1 }),
    ).toBe(false); // unknown field
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioLayout", null)).toBe(false);
  });

  it("studioSurface: accepts v4 Scratch Documents and rejects legacy writes", () => {
    const current = {
      version: 4,
      pinnedTabs: ["plan"],
      notification: null,
      conversations: {},
      scratchProjects: {
        "/repo": {
          documents: [{ id: "scratch-1", fileName: "Untitled-1.md", content: "notes", savedContent: "", isPreview: false }],
        },
      },
    };
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioSurface", current)).toBe(true);
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioSurface", { ...current, version: 3 })).toBe(false);
  });

  it("studioDockPresence: boolean-validated and re-applied live to the open window", () => {
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioDockPresence", "on")).toBe(
      false,
    );
    expect(applyStudioActivationPolicyMock).not.toHaveBeenCalled();
    expect(invoke(IPC.STUDIO_SET_SETTING, "studioDockPresence", false)).toBe(
      true,
    );
    // isStudioWindowOpen mocked true: the policy is re-applied for the open window.
    expect(applyStudioActivationPolicyMock).toHaveBeenCalledWith(true);
  });
});

describe("studio:read-theme-* validation", () => {
  it("rejects non-string pack ids and paths", () => {
    expect(invoke(IPC.STUDIO_READ_THEME_BUNDLE, 42)).toBeNull();
    expect(invoke(IPC.STUDIO_READ_THEME_ASSET, "ion-works", 42)).toBeNull();
    expect(invoke(IPC.STUDIO_READ_THEME_ASSET, null, "a.png")).toBeNull();
  });
});

describe("studio:worktree-sync", () => {
  const snapshot = {
    ready: true,
    inventory: { "/repo": [] },
    workspaces: { "/repo": [] },
    benchSourceTips: [["/repo", { main: "abc123" }]],
    benchRetired: [["/repo", [["main", []]]]],
    gitConflictAlerts: [["/worktree", { source: "sync", dismissed: false, recordedAt: 1 }]],
    worktreePipeline: null,
    workspaceOperationLedger: [{
      id: "op-1",
      action: "sync",
      status: "running",
      startedAt: 1,
    }],
  };

  it("accepts owner snapshots, assigns a revision, and fans them out", () => {
    const publish = onHandlers.get(IPC.STUDIO_PUBLISH_WORKTREE_SYNC);
    publish!(ownerEvent(), snapshot);

    expect(broadcastMock).toHaveBeenCalledWith(
      IPC.STUDIO_WORKTREE_SYNC,
      expect.objectContaining({ ...snapshot, revision: 1 }),
    );
    expect(invoke(IPC.STUDIO_GET_WORKTREE_SYNC)).toEqual({
      ...snapshot,
      revision: 1,
    });
  });

  it("rejects non-owner and malformed snapshots without replacing the cache", () => {
    const publish = onHandlers.get(IPC.STUDIO_PUBLISH_WORKTREE_SYNC);
    publish!(ownerEvent(2), snapshot);
    publish!(ownerEvent(), { ...snapshot, workspaceOperationLedger: {} });

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(invoke(IPC.STUDIO_GET_WORKTREE_SYNC)).toEqual({
      ...snapshot,
      revision: 1,
    });
  });
});

describe("studio:open", () => {
  it("opens the window via the window manager", () => {
    const handler = onHandlers.get(IPC.STUDIO_OPEN);
    expect(handler).toBeDefined();
    handler!({});
    expect(openStudioWindowMock).toHaveBeenCalled();
  });
});

describe("studio:get-settings studioEnabled derivation (single-UI exclusivity)", () => {
  it("returns studioEnabled: false when studio is not the active UI", () => {
    vi.mocked(readSettings).mockReturnValueOnce({ studioTheme: "ion-works" });
    const result = invoke(IPC.STUDIO_GET_SETTINGS) as Record<string, unknown>;
    expect(result.studioEnabled).toBe(false);
  });

  it("returns studioEnabled: true when studio is the active UI (gate + preference)", () => {
    vi.mocked(readSettings).mockReturnValueOnce({
      studioTheme: "ion-works",
      studioBeta: true,
      activeUi: "studio",
    });
    const result = invoke(IPC.STUDIO_GET_SETTINGS) as Record<string, unknown>;
    expect(result.studioEnabled).toBe(true);
  });

  it("returns studioEnabled: false when the gate is on but overlay is active", () => {
    vi.mocked(readSettings).mockReturnValueOnce({
      studioTheme: "ion-works",
      studioBeta: true,
      activeUi: "overlay",
    });
    const result = invoke(IPC.STUDIO_GET_SETTINGS) as Record<string, unknown>;
    expect(result.studioEnabled).toBe(false);
  });

  it("legacy overlay-only surfacePolicy still resolves overlay", () => {
    vi.mocked(readSettings).mockReturnValueOnce({
      studioTheme: "ion-works",
      studioBeta: true,
      surfacePolicy: "overlay-only",
    });
    const result = invoke(IPC.STUDIO_GET_SETTINGS) as Record<string, unknown>;
    expect(result.studioEnabled).toBe(false);
  });
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
