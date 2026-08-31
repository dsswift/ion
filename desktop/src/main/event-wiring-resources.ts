// Resource subscription and tab-focus publishing for the engine bridge.
//
// Extracted from event-wiring.ts to keep that file under the 600-line cap.
// This module handles:
//   - Per-session resource subscriptions (wildcard — every kind)
//   - Global resource subscriptions (wildcard — every workspace kind)
//   - Tab focus publishing (desktop.focus resource on tab switch)
//   - Read-state and deletion-tombstone persistence under ~/.ion

import { ipcMain } from "electron";
import { IPC } from "../shared/types";
import type { NormalizedEvent } from "../shared/types";
import { tabIdFromKey } from "../shared/session-key";
import { log as _log } from "./logger";
import { engineBridge, state } from "./state";
import { broadcast } from "./broadcast";
import { resourceCatalog } from "./resource-catalog";
import { notifyStudioActiveTab } from "./studio-window-manager";
import { restoreConversationCharts } from "./chart-restore";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

// ── Active session key tracking ────────────────────────────────────────────
//
// Tracks session keys (tabId:instanceId) that have successfully subscribed to
// per-session resource kinds. Persists across clearResourceSubscriptions() so
// that on engine reconnect (desktop restart connecting to a running engine),
// resubscribeSessionResourceKinds() can re-establish per-session subscriptions
// for all active sessions without waiting for engine_command_registry (which
// only fires on initial session creation, not on reconnect).
const activeSessionKeys = new Set<string>();

/** Register a session key as active. Called after a successful per-session
 *  resource subscription so the key survives reconnect cycles. */
export function recordActiveSessionKey(key: string): void {
  activeSessionKeys.add(key);
}

/** Re-subscribe to per-session resource kinds for all known active session keys.
 *  Called after clearResourceSubscriptions() on engine reconnect to recover
 *  subscriptions that would otherwise wait for engine_command_registry. */
export async function resubscribeSessionResourceKinds(): Promise<void> {
  if (activeSessionKeys.size === 0) {
    log("resource_subscribe: no active session keys to resubscribe");
    return;
  }
  log("resource_subscribe: resubscribing after reconnect", {
    count: activeSessionKeys.size,
  });
  const keys = Array.from(activeSessionKeys);
  await Promise.allSettled(
    keys.map((key) =>
      subscribeToResourceKinds(key).catch((err) => {
        log("resource_subscribe: resubscribe error", {
          key,
          error: String(err),
        });
      }),
    ),
  );
}

// ── Resource-state persistence ──────────────────────────────────────────────

export {
  isResourceRead,
  markReadPersisted,
  isResourceDeleted,
  markDeletedPersisted,
  filterDeletedResources,
  projectPersistedResourceState,
} from "./event-wiring-resource-state";
import {
  isResourceRead,
  markReadPersisted,
  isResourceDeleted,
  markDeletedPersisted,
  projectPersistedResourceState,
  getPersistedReadIds,
} from "./event-wiring-resource-state";

export function handleResourceEngineEvent(
  key: string,
  event: any,
  broadcastNormalized: (tabId: string, event: NormalizedEvent) => void,
): void {
  if (event.type === "engine_resource_snapshot") {
    const items = projectPersistedResourceState(event.resourceItems ?? []);
    log("resource_snapshot", {
      key,
      kind: event.resourceKind,
      sub_id: event.resourceSubId,
      items: items.length,
    });
    resourceCatalog.applySnapshot(
      key,
      event.resourceKind,
      items,
      event.resourceProducers,
    );
    broadcastNormalized(tabIdFromKey(key), {
      type: "resource_snapshot",
      resourceKind: event.resourceKind,
      resourceSubId: event.resourceSubId,
      resourceItems: items,
      resourceProducers: event.resourceProducers,
    });
    return;
  }
  if (event.type === "engine_resource_delta") {
    const d = event.resourceDelta;
    log("resource_delta", {
      key,
      kind: event.resourceKind,
      op: d?.op,
      id: d?.item?.id?.slice(-8),
      conv_id: d?.item?.conversationId ?? "global",
    });
    if (!d) return;
    const deleted = isResourceDeleted(d.item.id, d.item.producer, d.item.kind);
    if (deleted && d.op !== "delete") {
      log("resource_delta: ignored for deleted resource", {
        kind: event.resourceKind,
        op: d.op,
        id: d.item.id,
        producer: d.item.producer ?? "",
      });
      return;
    }
    if (d.op === "mark_read")
      markReadPersisted(d.item.id, d.item.producer, d.item.kind);
    if (d.op === "delete")
      markDeletedPersisted(d.item.id, d.item.producer, d.item.kind);
    resourceCatalog.applyDelta(event.resourceKind, d);
    broadcastNormalized(tabIdFromKey(key), {
      type: "resource_delta",
      resourceKind: event.resourceKind,
      resourceDelta: d,
    });
    return;
  }
  if (event.type === "engine_resource_item") {
    log("resource_item", {
      key,
      kind: event.resourceKind,
      id: event.resourceItem?.id?.slice(-8),
    });
    if (event.resourceItem)
      resourceCatalog.applyFullItem(event.resourceKind, event.resourceItem);
    handleResourceItemEvent(
      tabIdFromKey(key),
      event.resourceKind,
      event.resourceItem,
    );
  }
}

//
// The desktop subscribes to EVERY resource kind generically using the engine's
// wildcard sentinel ("*"). It never enumerates kinds — any kind any extension
// declares "just works" with zero desktop code change. This is the
// transport-level default and is not user-configurable; the engine fans every
// kind to the wildcard subscriber, and the desktop decides (client-side) which
// kinds to *show* in the global tray via the user's exclusion preference.
//
// Categorization is by data, not by a hardcoded kind:
//   - conversation-scoped resources (conversationId set) → that conversation's
//     attachments panel; always subscribed, never filtered.
//   - workspace/global resources (conversationId empty) → the global tray;
//     subject to the user's excludedResourceKinds blocklist at render time.
const WILDCARD_RESOURCE_KIND = "*";

// Active subscriptions keyed by `${sessionKey}:${kind}` → subscriptionId.
// Prevents double-subscribing when engine_command_registry fires more than
// once for the same session (e.g. after extension respawn).
const resourceSubscriptionIds = new Map<string, string>();

/** Clear subscription tracking on engine reconnect. Old subscription IDs
 *  are stale after a reconnect (the engine assigned new ones). Without
 *  clearing, subscribeToResourceKinds skips every kind because the dedup
 *  map still holds entries from the dead connection. */
export function clearResourceSubscriptions(): void {
  resourceSubscriptionIds.clear();
}

export async function subscribeToResourceKinds(key: string): Promise<void> {
  const kind = WILDCARD_RESOURCE_KIND;
  const subKey = `${key}:${kind}`;
  if (resourceSubscriptionIds.has(subKey)) {
    log("resource_subscribe: already subscribed", { key });
    return;
  }
  log("resource_subscribe: wildcard", { key, kind });
  const result = await engineBridge.request<{ subscriptionId: string }>(
    "resource_subscribe",
    { key, resourceKind: kind },
  );
  if (result.ok && result.data?.subscriptionId) {
    resourceSubscriptionIds.set(subKey, result.data.subscriptionId);
    // Track this key so it can be resubscribed on engine reconnect.
    recordActiveSessionKey(key);
    log("resource_subscribe: ok", {
      key,
      kind,
      sub_id: result.data.subscriptionId,
    });
    const conversationId =
      engineBridge.activeSessions?.get(key)?.conversationId ?? "";
    if (conversationId) {
      void restoreConversationCharts(engineBridge, key, conversationId).catch(
        (err: unknown) => {
          log("chart restore: error", { key, error: String(err) });
        },
      );
    }
  } else {
    log("resource_subscribe: failed", {
      key,
      kind,
      error: result.error ?? "no data",
    });
  }
}

export function ensureSessionResourceSubscription(key: string): void {
  if (!key || resourceSubscriptionIds.has(`${key}:${WILDCARD_RESOURCE_KIND}`))
    return;
  void subscribeToResourceKinds(key).catch((err: unknown) => {
    log("resource_subscribe: ensure error", { key, error: String(err) });
  });
}

export async function subscribeToGlobalResourceKinds(): Promise<void> {
  const kind = WILDCARD_RESOURCE_KIND;
  const subKey = `global:${kind}`;
  if (resourceSubscriptionIds.has(subKey)) {
    log("resource_subscribe_global: already subscribed");
    return;
  }
  log("resource_subscribe_global: wildcard", { kind });
  const result = await engineBridge.request<{ subscriptionId: string }>(
    "resource_subscribe",
    { key: "", resourceKind: kind, resourceGlobal: true },
  );
  if (result.ok && result.data?.subscriptionId) {
    resourceSubscriptionIds.set(subKey, result.data.subscriptionId);
    log("resource_subscribe_global: ok", {
      kind,
      sub_id: result.data.subscriptionId,
    });
  } else {
    log("resource_subscribe_global: failed", {
      kind,
      error: result.error ?? "no data",
    });
  }
}

// ── Tab focus resource publishing ─────────────────────────────────────────
//
// When the user switches tabs, the renderer calls notifyTabFocus(tabId).
// The main process publishes the focused session key as a workspace-scoped
// resource (kind: "desktop.focus") through the engine's resource_publish
// command. Extensions subscribe to this resource to know which session
// the user is currently viewing.

const focusResourceId = `focus-${Date.now()}`;

function publishTabFocus(tabId: string): void {
  const sessionKey = tabId;
  log("desktop_focus: publishing", { tab_id: tabId, session_key: sessionKey });

  engineBridge
    .request("resource_publish", {
      key: "",
      resourceKind: "desktop.focus",
      resourceGlobal: true,
      resourceOp: "update",
      resourceItem: {
        id: focusResourceId,
        kind: "desktop.focus",
        content: JSON.stringify({
          focusedSessionKey: sessionKey,
          focusedTabId: tabId,
        }),
        createdAt: new Date().toISOString(),
      },
    })
    .catch((err: unknown) => {
      log("desktop_focus: publish failed", { error: String(err) });
    });
}

export function wireTabFocusHandler(): void {
  ipcMain.on(
    IPC.NOTIFY_TAB_FOCUS,
    (
      _event: Electron.IpcMainEvent,
      {
        tabId,
        engineProfileId,
      }: { tabId: string; engineProfileId?: string | null },
    ) => {
      publishTabFocus(tabId);
      // The Ion Studio tracks the active tab through this same
      // notification: record it so an Studio window opened later targets the
      // right tab, and push it (with cached state) to a live Studio window.
      // engineProfileId scopes the Studio window office seed per extension.
      state.studioActiveTabId = tabId;
      state.studioActiveProfileId = engineProfileId ?? null;
      notifyStudioActiveTab(tabId);
    },
  );
}

// ── Mark-read publishing ────────────────────────────────────────────────────
//
// When the user opens a resource on desktop, the renderer calls
// markResourceRead via the preload bridge. The main process publishes a
// mark_read delta back to the engine so all other subscribers (e.g. iOS)
// see the item as read.

export async function publishResourceMarkRead(
  kind: string,
  resourceId: string,
  producer?: string,
): Promise<void> {
  log("resource_mark_read", {
    kind,
    resource_id: resourceId,
    producer: producer ?? "",
  });
  const result = await engineBridge.request("resource_publish", {
    key: "",
    resourceKind: kind,
    resourceGlobal: true,
    resourceOp: "mark_read",
    resourceProducer: producer,
    resourceItem: { id: resourceId, kind, content: "", createdAt: "" },
  });
  if (!result.ok) {
    const message =
      result.error ?? "engine rejected resource mark-read publish";
    log("resource_mark_read: failed", {
      kind,
      resource_id: resourceId,
      producer: producer ?? "",
      error: message,
    });
    throw new Error(message);
  }
  log("resource_mark_read: published", {
    kind,
    resource_id: resourceId,
    producer: producer ?? "",
  });
}

export function wireMarkResourceReadHandler(): void {
  ipcMain.on(
    IPC.MARK_RESOURCE_READ,
    (
      _event: Electron.IpcMainEvent,
      {
        kind,
        resourceId,
        producer,
      }: { kind: string; resourceId: string; producer?: string },
    ) => {
      markReadPersisted(resourceId, producer, kind);
      publishResourceMarkRead(kind, resourceId, producer).catch((err) => {
        log("resource_mark_read: publish failed", {
          kind,
          resource_id: resourceId,
          producer: producer ?? "",
          error: String(err),
        });
      });
    },
  );
  ipcMain.handle(IPC.GET_READ_RESOURCE_IDS, () => {
    return getPersistedReadIds();
  });
  ipcMain.handle(IPC.GET_PERSISTED_RESOURCES, () => {
    const items = projectPersistedResourceState(
      resourceCatalog.bootstrapItems(isResourceRead),
    );
    const globalCount = items.filter((item) => !item.conversationId).length;
    log("resource_catalog_bootstrap", {
      total: items.length,
      global: globalCount,
      scoped: items.length - globalCount,
    });
    return items;
  });
}

// ── Delete resource publishing ──────────────────────────────────────────────
//
// When the user deletes a resource on desktop, the renderer calls
// publishResourceDelete via the preload bridge. The main process publishes a
// delete op back to the engine so all other subscribers (e.g. iOS) remove
// the item.

export async function publishResourceDelete(
  kind: string,
  resourceId: string,
  producer?: string,
): Promise<void> {
  log("resource_delete", {
    kind,
    resource_id: resourceId,
    producer: producer ?? "",
  });
  const result = await engineBridge.request("resource_publish", {
    key: "",
    resourceKind: kind,
    resourceGlobal: true,
    resourceOp: "delete",
    resourceProducer: producer,
    resourceItem: { id: resourceId, kind, content: "", createdAt: "" },
  });
  if (!result.ok) {
    const message = result.error ?? "engine rejected resource delete publish";
    log("resource_delete: failed", {
      kind,
      resource_id: resourceId,
      producer: producer ?? "",
      error: message,
    });
    throw new Error(message);
  }
  log("resource_delete: published", {
    kind,
    resource_id: resourceId,
    producer: producer ?? "",
  });
}

export function wireDeleteResourceHandler(): void {
  ipcMain.on(
    IPC.DELETE_RESOURCE,
    (
      _event: Electron.IpcMainEvent,
      {
        kind,
        resourceId,
        producer,
      }: { kind: string; resourceId: string; producer?: string },
    ) => {
      markDeletedPersisted(resourceId, producer, kind);
      publishResourceDelete(kind, resourceId, producer).catch((err) => {
        log("resource_delete: publish failed", {
          kind,
          resource_id: resourceId,
          producer: producer ?? "",
          error: String(err),
        });
      });
    },
  );
}

// ── resource_get: lazy fetch of a single item's full content ───────────────
//
// Sends resource_get to the engine for the given kind + id. The engine calls
// the registered producer's query handler and emits engine_resource_item back
// on the requesting connection, which event-wiring.ts broadcasts to the
// renderer as resource_item. This call resolves once the command round-trip
// completes; the actual item arrives via the event stream (engine_resource_item).
//
// resourceGlobal=true targets the workspace-level broker (briefings, global
// notifications). resourceGlobal=false (default) targets the per-session broker
// identified by sessionKey.
export async function resourceGet(
  kind: string,
  id: string,
  opts: { sessionKey?: string; global?: boolean; producer?: string } = {},
): Promise<void> {
  const key = opts.sessionKey ?? "";
  const resourceGlobal = opts.global ?? true;
  log("resource_get", { kind, id: id.slice(-8), global: resourceGlobal });
  await engineBridge
    .request("resource_get", {
      key,
      resourceKind: kind,
      resourceId: id,
      resourceProducer: opts.producer,
      resourceGlobal,
    })
    .catch((err: unknown) => {
      log("resource_get: failed", {
        kind,
        id: id.slice(-8),
        error: String(err),
      });
    });
}

export function wireResourceGetHandler(): void {
  ipcMain.handle(
    IPC.RESOURCE_GET,
    async (
      _event: Electron.IpcMainInvokeEvent,
      {
        kind,
        id,
        producer,
        sessionKey,
        global: isGlobal,
      }: {
        kind: string;
        id: string;
        producer?: string;
        sessionKey?: string;
        global?: boolean;
      },
    ) => {
      await resourceGet(kind, id, { sessionKey, global: isGlobal, producer });
    },
  );
}

// ── handleResourceItemEvent ────────────────────────────────────────────────
// Broadcasts a resource_item NormalizedEvent to the renderer. Called from
// event-wiring.ts when engine_resource_item arrives — extracted here to keep
// event-wiring.ts under the 600-line cap.
export function handleResourceItemEvent(
  tabId: string,
  resourceKind: string,
  resourceItem: import("../shared/types-engine").ResourceItem | undefined,
): void {
  if (!resourceItem) {
    return;
  }
  broadcast("ion:normalized-event", tabId, {
    type: "resource_item" as const,
    resourceKind,
    resourceItem,
  });
}
