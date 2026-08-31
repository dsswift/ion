import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  capturedHandler,
  broadcast,
  applyDelta,
  applyFullItem,
  handleResourceItemEvent,
  isResourceDeleted,
  markDeletedPersisted,
  markReadPersisted,
} = vi.hoisted(() => ({
  capturedHandler: {
    fn: null as null | ((key: string, event: Record<string, unknown>) => void),
  },
  broadcast: vi.fn(),
  applyDelta: vi.fn(),
  applyFullItem: vi.fn(),
  handleResourceItemEvent: vi.fn(),
  handleResourceEngineEvent: vi.fn(),
  isResourceDeleted: vi.fn(
    (_id?: string, _producer?: string, _kind?: string) => false,
  ),
  markDeletedPersisted: vi.fn(),
  markReadPersisted: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));
vi.mock("../state", () => ({
  state: { remoteTransport: null, mainWindow: null },
  sessionPlane: { on: vi.fn() },
  engineBridge: {
    on: vi.fn(
      (
        event: string,
        handler: (key: string, value: Record<string, unknown>) => void,
      ) => {
        if (event === "event") capturedHandler.fn = handler;
      },
    ),
  },
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: new Set(),
  lastForwardedTabMeta: new Map(),
}));
vi.mock("../broadcast", () => ({ broadcast }));
vi.mock("../resource-catalog", () => ({
  resourceCatalog: {
    clear: vi.fn(),
    applySnapshot: vi.fn(),
    applyDelta,
    applyFullItem,
  },
}));
vi.mock("../event-wiring-resources", () => ({
  handleResourceEngineEvent: (
    key: string,
    event: Record<string, unknown>,
    emit: (tabId: string, event: unknown) => void,
  ) => {
    const resourceEvent = event as {
      type: string;
      resourceKind: string;
      resourceDelta?: unknown;
      resourceItem?: unknown;
    };
    if (
      resourceEvent.type === "engine_resource_delta" &&
      resourceEvent.resourceDelta
    ) {
      const delta = resourceEvent.resourceDelta as {
        op: string;
        item: { id: string; producer?: string; kind: string };
      };
      if (
        isResourceDeleted(
          delta.item.id,
          delta.item.producer,
          delta.item.kind,
        ) &&
        delta.op !== "delete"
      )
        return;
      if (delta.op === "mark_read")
        markReadPersisted(delta.item.id, delta.item.producer, delta.item.kind);
      if (delta.op === "delete")
        markDeletedPersisted(
          delta.item.id,
          delta.item.producer,
          delta.item.kind,
        );
      applyDelta(resourceEvent.resourceKind, delta);
      emit(key, {
        type: "resource_delta",
        resourceKind: resourceEvent.resourceKind,
        resourceDelta: delta,
      });
    } else if (
      resourceEvent.type === "engine_resource_item" &&
      resourceEvent.resourceItem
    ) {
      applyFullItem(resourceEvent.resourceKind, resourceEvent.resourceItem);
      handleResourceItemEvent(
        key,
        resourceEvent.resourceKind,
        resourceEvent.resourceItem,
      );
    }
  },
  subscribeToResourceKinds: vi.fn(() => Promise.resolve()),
  subscribeToGlobalResourceKinds: vi.fn(() => Promise.resolve()),
  clearResourceSubscriptions: vi.fn(),
  markReadPersisted,
  isResourceDeleted,
  markDeletedPersisted,
  resubscribeSessionResourceKinds: vi.fn(() => Promise.resolve()),
  handleResourceItemEvent,
  projectPersistedResourceState: vi.fn((items: unknown[]) => items),
}));
vi.mock("../event-wiring-intercept", () => ({ handleInterceptEvent: vi.fn() }));
vi.mock("../event-wiring-text-delta-batcher", () => ({
  accumulateTextDelta: vi.fn(),
  flushKeyDeltas: vi.fn(),
  dropKeyDeltas: vi.fn(),
}));
vi.mock("../event-wiring-provider-login", () => ({
  handleProviderLoginEvent: vi.fn(),
  handleProvidersUpdatedEvent: vi.fn(),
}));
vi.mock("../studio-window-manager", () => ({
  notifyStudioPermissionResolved: vi.fn(),
}));
vi.mock("../settings-store", () => ({
  shouldStreamThinkingToRemote: vi.fn(() => false),
}));
vi.mock("../logger", () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("../../shared/clear-divider", () => ({
  formatClearDivider: vi.fn(() => "[clear]"),
}));

import { wireEngineBridgeEvents } from "../event-wiring";

describe("event-wiring resource catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isResourceDeleted.mockReturnValue(false);
    capturedHandler.fn = null;
    wireEngineBridgeEvents();
  });

  it("updates the catalog and both renderers from a resource mutation delta", () => {
    const delta = {
      op: "mark_read",
      item: {
        id: "briefing-1",
        kind: "briefing",
        producer: "producer-a",
        content: "",
        createdAt: "",
      },
    };
    const order: string[] = [];
    markReadPersisted.mockImplementation(() => order.push("persisted"));
    applyDelta.mockImplementation(() => order.push("catalog"));
    broadcast.mockImplementation(() => order.push("renderers"));

    capturedHandler.fn?.("", {
      type: "engine_resource_delta",
      resourceKind: "briefing",
      resourceDelta: delta,
    });

    expect(markReadPersisted).toHaveBeenCalledWith(
      "briefing-1",
      "producer-a",
      "briefing",
    );
    expect(applyDelta).toHaveBeenCalledWith("briefing", delta);
    expect(broadcast).toHaveBeenCalledWith("ion:normalized-event", "", {
      type: "resource_delta",
      resourceKind: "briefing",
      resourceDelta: delta,
    });
    expect(order).toEqual(["persisted", "catalog", "renderers"]);
  });

  it("persists a delete tombstone before broadcasting the deletion", () => {
    const delta = {
      op: "delete",
      item: {
        id: "briefing-1",
        kind: "briefing",
        producer: "producer-a",
        content: "",
        createdAt: "",
      },
    };

    capturedHandler.fn?.("", {
      type: "engine_resource_delta",
      resourceKind: "briefing",
      resourceDelta: delta,
    });

    expect(markDeletedPersisted).toHaveBeenCalledWith(
      "briefing-1",
      "producer-a",
      "briefing",
    );
    expect(broadcast).toHaveBeenCalledWith("ion:normalized-event", "", {
      type: "resource_delta",
      resourceKind: "briefing",
      resourceDelta: delta,
    });
  });

  it("does not restore a deleted resource from a later producer delta", () => {
    isResourceDeleted.mockReturnValue(true);
    const delta = {
      op: "create",
      item: {
        id: "briefing-1",
        kind: "briefing",
        producer: "producer-a",
        content: "",
        createdAt: "",
      },
    };

    capturedHandler.fn?.("", {
      type: "engine_resource_delta",
      resourceKind: "briefing",
      resourceDelta: delta,
    });

    expect(applyDelta).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("updates the catalog before forwarding a full resource item", () => {
    const item = {
      id: "briefing-1",
      kind: "briefing",
      producer: "producer-a",
      content: "full body",
      createdAt: "",
    };
    const order: string[] = [];
    applyFullItem.mockImplementation(() => order.push("catalog"));
    handleResourceItemEvent.mockImplementation(() => order.push("renderer"));

    capturedHandler.fn?.("tab-1", {
      type: "engine_resource_item",
      resourceKind: "briefing",
      resourceItem: item,
    });

    expect(applyFullItem).toHaveBeenCalledWith("briefing", item);
    expect(handleResourceItemEvent).toHaveBeenCalledWith(
      "tab-1",
      "briefing",
      item,
    );
    expect(order).toEqual(["catalog", "renderer"]);
  });
});
