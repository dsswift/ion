/**
 * Regression test for planFilePath validation in `ipc/engine.ts`.
 *
 * Bug: the `ion:engine-set-plan-mode` and SET_PERMISSION_MODE handlers forwarded
 * a renderer/iOS-supplied filesystem `planFilePath` straight to the engine with
 * no validation. The fix routes the path through isValidProjectPath and degrades
 * a malformed path to "no restore" (undefined) — the plan-mode toggle / permission
 * mode still applies; only the bad restore path is dropped.
 *
 * These assertions fail on the pre-fix code (which forwarded the malformed path
 * verbatim) and pass after the guard.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const handlers = new Map<string, (...args: any[]) => any>();

vi.mock("electron", () => ({
  app: {},
  session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }),
  },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    },
    on: (channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    },
  },
}));

const mocks = vi.hoisted(() => ({
  sendSetPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
}));

vi.mock("../state", () => ({
  enterprisePolicyCache: { policy: null },
  state: { remoteTransport: null },
  engineBridge: { sendSetPlanMode: mocks.sendSetPlanMode },
  sessionPlane: { setPermissionMode: mocks.setPermissionMode },
}));

vi.mock("../logger", () => ({ log: vi.fn() }));

vi.mock("../remote/handlers/engine-history", () => ({
  broadcastEngineHistory: vi.fn(),
}));

import { registerEngineIpc, sanitizePlanFilePath } from "../ipc/engine";
import { IPC } from "../../shared/types";

beforeEach(() => {
  handlers.clear();
  mocks.sendSetPlanMode.mockClear();
  mocks.setPermissionMode.mockClear();
  registerEngineIpc();
});

describe("ipc/engine planFilePath validation", () => {
  describe("sanitizePlanFilePath", () => {
    it("passes through a valid absolute path", () => {
      expect(sanitizePlanFilePath("/Users/me/proj/PLAN.md", "test")).toBe(
        "/Users/me/proj/PLAN.md",
      );
    });

    it("drops undefined", () => {
      expect(sanitizePlanFilePath(undefined, "test")).toBeUndefined();
    });

    it("drops a relative (malformed) path", () => {
      expect(sanitizePlanFilePath("relative/PLAN.md", "test")).toBeUndefined();
    });

    it("drops a path with a newline injection", () => {
      expect(
        sanitizePlanFilePath("/Users/me/proj\nPLAN.md", "test"),
      ).toBeUndefined();
    });

    it("drops a path with a null byte", () => {
      expect(
        sanitizePlanFilePath("/Users/me/proj\0PLAN.md", "test"),
      ).toBeUndefined();
    });
  });

  describe("ion:engine-set-plan-mode handler", () => {
    it("forwards a valid planFilePath", () => {
      handlers.get("ion:engine-set-plan-mode")!(
        null,
        "key-1",
        true,
        "/abs/PLAN.md",
      );
      expect(mocks.sendSetPlanMode).toHaveBeenCalledWith(
        "key-1",
        true,
        undefined,
        "prompt_sync",
        undefined,
        "/abs/PLAN.md",
      );
    });

    it("still enables plan mode but drops a malformed planFilePath (degrade, not abort)", () => {
      handlers.get("ion:engine-set-plan-mode")!(
        null,
        "key-1",
        true,
        "../escape/PLAN.md",
      );
      // The toggle still fires; only the bad restore path is dropped to undefined.
      expect(mocks.sendSetPlanMode).toHaveBeenCalledWith(
        "key-1",
        true,
        undefined,
        "prompt_sync",
        undefined,
        undefined,
      );
    });
  });

  describe("SET_PERMISSION_MODE handler", () => {
    it("forwards a valid planFilePath with the mode", () => {
      handlers.get(IPC.SET_PERMISSION_MODE)!(null, {
        tabId: "tab1",
        mode: "plan",
        planFilePath: "/abs/PLAN.md",
      });
      expect(mocks.setPermissionMode).toHaveBeenCalledWith(
        "tab1",
        "plan",
        undefined,
        "/abs/PLAN.md",
      );
    });

    it("still applies the mode but drops a malformed planFilePath", () => {
      handlers.get(IPC.SET_PERMISSION_MODE)!(null, {
        tabId: "tab1",
        mode: "plan",
        planFilePath: "bad\npath",
      });
      expect(mocks.setPermissionMode).toHaveBeenCalledWith(
        "tab1",
        "plan",
        undefined,
        undefined,
      );
    });

    it("ignores an invalid mode entirely", () => {
      handlers.get(IPC.SET_PERMISSION_MODE)!(null, {
        tabId: "tab1",
        mode: "bogus",
        planFilePath: "/abs/PLAN.md",
      });
      expect(mocks.setPermissionMode).not.toHaveBeenCalled();
    });
  });
});
