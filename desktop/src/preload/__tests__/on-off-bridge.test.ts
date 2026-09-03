/**
 * Preload `on`/`off` bridge — listener registration and removal.
 *
 * REGRESSION PIN: `on` registers a WRAPPER around the caller's callback (the
 * wrapper forwards the IpcRendererEvent first argument), but `off` used to call
 * `ipcRenderer.removeListener(channel, callback)` with the ORIGINAL callback.
 * The identities differ, so the removal silently no-opped and every `on`
 * registration stayed attached forever.
 *
 * The consequence in the app: `useEngineEvents` registers a dozen channels in
 * an effect and removes them in its cleanup. Any effect re-run (a remount, a
 * dependency change, a StrictMode double-invoke in dev) left the previous
 * listeners live, so one main-process broadcast invoked the handler N times.
 * On IPC.REMOTE_USER_MESSAGE that is N optimistic user bubbles for a single
 * iOS prompt.
 *
 * These tests drive the REAL preload module (not a reimplementation) by
 * mocking 'electron' and capturing the object handed to
 * contextBridge.exposeInMainWorld, so they cannot drift from shipped code.
 */
import { IPC } from "../../shared/types";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => void;

/**
 * ipcRenderer double with Node-EventEmitter removal semantics: removeListener
 * drops the first entry matching by reference identity.
 */
const listeners = new Map<string, Handler[]>();

const fakeIpc = {
  on: vi.fn((channel: string, handler: Handler) => {
    const arr = listeners.get(channel) ?? [];
    arr.push(handler);
    listeners.set(channel, arr);
  }),
  removeListener: vi.fn((channel: string, handler: Handler) => {
    const arr = listeners.get(channel);
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx !== -1) arr.splice(idx, 1);
  }),
  send: vi.fn(),
  invoke: vi.fn(() => Promise.resolve()),
  once: vi.fn(),
  removeAllListeners: vi.fn(),
  sendSync: vi.fn(),
};

/** Captures the API object the preload module exposes. */
let exposed: Record<string, any> = {};

vi.mock("electron", () => ({
  ipcRenderer: fakeIpc,
  contextBridge: {
    exposeInMainWorld: (_key: string, value: Record<string, any>) => {
      // The module exposes 'ion' and may expose others; keep the one under test.
      if (_key === "ion") exposed = value;
    },
  },
  webUtils: { getPathForFile: () => "" },
}));

function emit(channel: string, ...args: unknown[]): void {
  for (const h of [...(listeners.get(channel) ?? [])]) h({}, ...args);
}

function count(channel: string): number {
  return (listeners.get(channel) ?? []).length;
}

beforeEach(async () => {
  listeners.clear();
  fakeIpc.on.mockClear();
  fakeIpc.removeListener.mockClear();
  fakeIpc.send.mockClear();
  fakeIpc.invoke.mockClear();
  // Import once; the module registers its API at load time.
  if (Object.keys(exposed).length === 0) await import("../index");
});

describe("preload module ownership", () => {
  it("does not let later modules replace an API owned by another module", async () => {
    const [{ requestApi }, { automationApi }, { engineApi }, { systemApi }] =
      await Promise.all([
        import("../api-request"),
        import("../api-automation"),
        import("../engine-api"),
        import("../api-system"),
      ]);
    const modules = [requestApi, automationApi, engineApi, systemApi];

    for (let left = 0; left < modules.length; left++) {
      for (let right = left + 1; right < modules.length; right++) {
        const duplicateKeys = Object.keys(modules[left]).filter(
          (key) => key in modules[right],
        );
        expect(duplicateKeys).toEqual([]);
      }
    }
  });
});

describe("preload automation bridge", () => {
  it("each automation listener removes the exact wrapper it registered", () => {
    const onEvent = exposed.onAutomationEvent(vi.fn());
    const onCommand = exposed.onAutomationCommand(vi.fn());
    expect(count(IPC.AUTOMATION_EVENT)).toBe(1);
    expect(count(IPC.AUTOMATION_COMMAND)).toBe(1);

    onEvent();
    onCommand();
    expect(count(IPC.AUTOMATION_EVENT)).toBe(0);
    expect(count(IPC.AUTOMATION_COMMAND)).toBe(0);
  });

  it("routes the source-aware listing and per-item CRUD through their channels", () => {
    exposed.automationListing("/repo");
    exposed.automationDelete("id-1");
    exposed.automationDuplicate("id-2", "/repo");
    expect(fakeIpc.invoke).toHaveBeenCalledWith(IPC.AUTOMATION_LISTING, "/repo");
    expect(fakeIpc.invoke).toHaveBeenCalledWith(IPC.AUTOMATION_DELETE, "id-1");
    expect(fakeIpc.invoke).toHaveBeenCalledWith(IPC.AUTOMATION_DUPLICATE, {
      id: "id-2",
      projectPath: "/repo",
    });
  });
});

describe("preload resource bridge", () => {
  it("preserves producer identity for read, delete, and get operations", () => {
    exposed.markResourceRead("briefing", "shared", "producer-a");
    exposed.publishResourceDelete("briefing", "shared", "producer-a");
    exposed.resourceGet("briefing", "shared", {
      global: true,
      producer: "producer-a",
    });

    expect(fakeIpc.send).toHaveBeenCalledWith(IPC.MARK_RESOURCE_READ, {
      kind: "briefing",
      resourceId: "shared",
      producer: "producer-a",
    });
    expect(fakeIpc.send).toHaveBeenCalledWith(IPC.DELETE_RESOURCE, {
      kind: "briefing",
      resourceId: "shared",
      producer: "producer-a",
    });
    expect(fakeIpc.invoke).toHaveBeenCalledWith(IPC.RESOURCE_GET, {
      kind: "briefing",
      id: "shared",
      global: true,
      producer: "producer-a",
    });
  });
});

describe("preload on/off bridge", () => {
  it("exposes on and off on the ion API", () => {
    expect(typeof exposed.on).toBe("function");
    expect(typeof exposed.off).toBe("function");
  });

  it("off actually removes the listener the wrapper registered", () => {
    const cb = vi.fn();
    exposed.on("ion:test", cb);
    expect(count("ion:test")).toBe(1);

    exposed.off("ion:test", cb);
    expect(count("ion:test")).toBe(0);

    emit("ion:test", "payload");
    expect(cb).not.toHaveBeenCalled();
  });

  it("REGRESSION: an effect re-run does not accumulate listeners", () => {
    // Simulates useEngineEvents mounting, cleaning up, and mounting again.
    const first = vi.fn();
    exposed.on("ion:remote-user-message", first);
    exposed.off("ion:remote-user-message", first);

    const second = vi.fn();
    exposed.on("ion:remote-user-message", second);

    expect(count("ion:remote-user-message")).toBe(1);

    // ONE broadcast must produce exactly ONE handler invocation. On the old
    // bridge the first listener survived and this fired twice — the
    // duplicate-user-bubble mechanism.
    emit("ion:remote-user-message", { prompt: "hello" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("re-registering the same callback on one channel is idempotent", () => {
    const cb = vi.fn();
    exposed.on("ion:test", cb);
    exposed.on("ion:test", cb);

    expect(count("ion:test")).toBe(1);
    emit("ion:test");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("forwards the event argument and payload to the callback", () => {
    const cb = vi.fn();
    exposed.on("ion:test", cb);
    emit("ion:test", "a", 2);
    expect(cb).toHaveBeenCalledWith({}, "a", 2);
  });

  it("tracks one callback across several channels independently", () => {
    const cb = vi.fn();
    exposed.on("ion:one", cb);
    exposed.on("ion:two", cb);

    exposed.off("ion:one", cb);

    expect(count("ion:one")).toBe(0);
    expect(count("ion:two")).toBe(1);
    emit("ion:two");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("distinct callbacks on one channel are removed independently", () => {
    const a = vi.fn();
    const b = vi.fn();
    exposed.on("ion:test", a);
    exposed.on("ion:test", b);
    expect(count("ion:test")).toBe(2);

    exposed.off("ion:test", a);
    emit("ion:test");

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("off on an unregistered callback is a no-op, not a throw", () => {
    expect(() => exposed.off("ion:test", vi.fn())).not.toThrow();
  });

  it("double off does not remove an unrelated later registration", () => {
    const cb = vi.fn();
    exposed.on("ion:test", cb);
    exposed.off("ion:test", cb);
    exposed.off("ion:test", cb);

    exposed.on("ion:test", cb);
    expect(count("ion:test")).toBe(1);
    emit("ion:test");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
