import { describe, it, expect, vi, beforeEach } from "vitest";

const readSettingsMock = vi.fn();
const writeSettingsMock = vi.fn();

const existsSyncMock = vi.fn();
const renameSyncMock = vi.fn();

vi.mock("fs", () => ({
  existsSync: (p: string): boolean => existsSyncMock(p) as boolean,
  renameSync: (a: string, b: string): void => {
    renameSyncMock(a, b);
  },
}));
vi.mock("../settings-store", () => ({
  readSettings: (): Record<string, unknown> =>
    readSettingsMock() as Record<string, unknown>,
  writeSettings: (s: Record<string, unknown>): void => {
    writeSettingsMock(s);
  },
}));
vi.mock("../logger", () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { migrateStudioSettings } from "../settings-migration-studio";

function written(): Record<string, unknown> {
  expect(writeSettingsMock).toHaveBeenCalledTimes(1);
  return writeSettingsMock.mock.calls[0][0] as Record<string, unknown>;
}

describe("migrateStudioSettings", () => {
  beforeEach(() => {
    readSettingsMock.mockReset();
    writeSettingsMock.mockReset();
    existsSyncMock.mockReset();
    renameSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false); // default: no legacy theme dir
  });

  it("no legacy keys → no write (idempotent steady state)", () => {
    readSettingsMock.mockReturnValue({
      studioTheme: "ion-works",
      activeUi: "studio",
    });
    expect(migrateStudioSettings()).toBe(false);
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it("renames every atv* key to studio* and deletes the old keys", () => {
    readSettingsMock.mockReturnValue({
      atvBounds: { x: 1, y: 2, width: 3, height: 4 },
      atvWindowOpen: true,
      atvPinned: true,
      atvTheme: "ion-works",
      atvZoom: 3,
      atvSeed: "office",
      atvSeeds: { local: "seed" },
      atvDockPresence: false,
      atvHeat: true,
      atvBeacon: false,
      atvSound: false,
      atvShortcut: "Alt+Shift+V",
      unrelated: "stays",
    });
    expect(migrateStudioSettings()).toBe(true);
    const s = written();
    expect(s).toMatchObject({
      studioBounds: { x: 1, y: 2, width: 3, height: 4 },
      studioTheme: "ion-works",
      studioZoom: 3,
      studioSeed: "office",
      studioSeeds: { local: "seed" },
      studioDockPresence: false,
      studioHeat: true,
      studioBeacon: false,
      studioSound: false,
      studioShortcut: "Alt+Shift+V",
      unrelated: "stays",
    });
    // Open-state persistence was removed with persistStudioOpenState(): the
    // Studio window no longer reopens from disk, so neither the old key nor a
    // renamed one may survive the migration.
    expect(s).not.toHaveProperty("studioWindowOpen");
    for (const key of Object.keys(s)) expect(key.startsWith("atv")).toBe(false);
  });

  it("pin keys are dropped (Studio is a normal window — no always-on-top)", () => {
    readSettingsMock.mockReturnValue({ atvPinned: true, studioPinned: true });
    migrateStudioSettings();
    const s = written();
    expect("atvPinned" in s).toBe(false);
    expect("studioPinned" in s).toBe(false);
  });

  it("F2: atvBeta AND studioBeta are dropped (gate retired at release)", () => {
    readSettingsMock.mockReturnValue({ atvBeta: true, studioBeta: true });
    migrateStudioSettings();
    const s = written();
    expect("atvBeta" in s).toBe(false);
    expect("studioBeta" in s).toBe(false);
  });

  it("existing new key wins: old value dropped, not overwritten", () => {
    readSettingsMock.mockReturnValue({
      atvTheme: "old-pack",
      studioTheme: "new-pack",
    });
    migrateStudioSettings();
    const s = written();
    expect(s.studioTheme).toBe("new-pack");
    expect("atvTheme" in s).toBe(false);
  });

  it("launchSurface value maps: atv→studio, both→overlay (D1: no both), overlay→overlay", () => {
    for (const [from, to] of [
      ["atv", "studio"],
      ["both", "overlay"],
      ["overlay", "overlay"],
    ] as const) {
      readSettingsMock.mockReturnValue({ launchSurface: from });
      writeSettingsMock.mockReset();
      migrateStudioSettings();
      const s = written();
      expect(s.activeUi).toBe(to);
      expect("launchSurface" in s).toBe(false);
    }
  });

  it("invalid launchSurface is dropped without minting an activeUi", () => {
    readSettingsMock.mockReturnValue({ launchSurface: "bogus" });
    migrateStudioSettings();
    const s = written();
    expect("activeUi" in s).toBe(false);
    expect("launchSurface" in s).toBe(false);
  });

  it("surfacePolicy folds into activeUi then is dropped", () => {
    readSettingsMock.mockReturnValue({ surfacePolicy: "atv-only" });
    migrateStudioSettings();
    expect(written()).toMatchObject({ activeUi: "studio" });

    writeSettingsMock.mockReset();
    readSettingsMock.mockReturnValue({ surfacePolicy: "overlay-only" });
    migrateStudioSettings();
    expect(written()).toMatchObject({ activeUi: "overlay" });

    writeSettingsMock.mockReset();
    readSettingsMock.mockReturnValue({ surfacePolicy: "both" });
    migrateStudioSettings();
    const s = written();
    expect("activeUi" in s).toBe(false);
    expect("surfacePolicy" in s).toBe(false);
  });

  it("launchSurface preference wins over the surfacePolicy fold", () => {
    // launchSurface is the user's own choice; surfacePolicy was the operator
    // clamp. When both exist the user preference sets activeUi first and the
    // policy fold sees activeUi present and only drops its key.
    readSettingsMock.mockReturnValue({
      launchSurface: "atv",
      surfacePolicy: "overlay-only",
    });
    migrateStudioSettings();
    expect(written().activeUi).toBe("studio");
  });

  it("atvAutoDrawer is dropped without replacement", () => {
    readSettingsMock.mockReturnValue({ atvAutoDrawer: true });
    migrateStudioSettings();
    expect("atvAutoDrawer" in written()).toBe(false);
  });

  it("atvLayout: dockTab maps three-valued onto studioLayout.leftSidebarView", () => {
    readSettingsMock.mockReturnValue({
      atvLayout: { dockOpen: true, dockWidth: 420, dockTab: "files" },
    });
    migrateStudioSettings();
    expect(
      (written().studioLayout as { leftSidebarView: string }).leftSidebarView,
    ).toBe("explorer");

    writeSettingsMock.mockReset();
    readSettingsMock.mockReturnValue({
      atvLayout: { dockOpen: false, dockWidth: 300, dockTab: "worktrees" },
    });
    migrateStudioSettings();
    const gitLayout = written().studioLayout as Record<string, unknown>;
    expect(gitLayout.leftSidebarView).toBe("git");
    // The migrated value is a COMPLETE layout (validator requires full shape).
    expect(Object.keys(gitLayout).sort()).toEqual([
      "dispatchSplitRatio",
      "leftSidebarView",
      "leftSidebarVisible",
      "surfaceWidth",
      "terminalHeight",
    ]);

    writeSettingsMock.mockReset();
    readSettingsMock.mockReturnValue({
      atvLayout: { dockOpen: true, dockWidth: 420, dockTab: "conversation" },
    });
    migrateStudioSettings();
    const s = written();
    expect("studioLayout" in s).toBe(false); // conversation → default, no key minted
    expect("atvLayout" in s).toBe(false);
  });

  it("second run after migration is a no-op", () => {
    readSettingsMock.mockReturnValue({
      atvTheme: "ion-works",
      launchSurface: "atv",
    });
    migrateStudioSettings();
    const migrated = written();

    writeSettingsMock.mockReset();
    readSettingsMock.mockReturnValue(migrated);
    expect(migrateStudioSettings()).toBe(false);
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it("read failure is logged and skipped, never throws", () => {
    readSettingsMock.mockImplementation(() => {
      throw new Error("corrupt");
    });
    expect(migrateStudioSettings()).toBe(false);
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it("theme packs: legacy ~/.ion/atv moves to ~/.ion/studio once", () => {
    readSettingsMock.mockReturnValue({});
    existsSyncMock.mockImplementation((p: string) => p.endsWith("/.ion/atv"));
    migrateStudioSettings();
    expect(renameSyncMock).toHaveBeenCalledTimes(1);
    const [from, to] = renameSyncMock.mock.calls[0] as [string, string];
    expect(from.endsWith("/.ion/atv")).toBe(true);
    expect(to.endsWith("/.ion/studio")).toBe(true);
  });

  it("theme packs: never overwrites an existing new root", () => {
    readSettingsMock.mockReturnValue({});
    existsSyncMock.mockReturnValue(true); // both roots exist
    migrateStudioSettings();
    expect(renameSyncMock).not.toHaveBeenCalled();
  });
});
