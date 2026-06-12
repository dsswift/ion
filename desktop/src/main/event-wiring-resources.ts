// Resource subscription and tab-focus publishing for the engine bridge.
//
// Extracted from event-wiring.ts to keep that file under the 600-line cap.
// This module handles:
//   - Per-session resource subscriptions (briefing kind)
//   - Global resource subscriptions (desktop.focus kind)
//   - Tab focus publishing (desktop.focus resource on tab switch)

import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { log as _log } from './logger'
import { engineBridge } from './state'

function log(msg: string): void {
  _log('main', msg)
}

// ── Resource subscription ──────────────────────────────────────────────────
//
// Known resource kinds the desktop subscribes to on every engine session.
// Add new kinds here as extensions declare them.
const SUBSCRIBED_RESOURCE_KINDS = ['briefing']

// Global resource kinds the desktop subscribes to once at engine connect
// (not per-session). These use the Manager-level global broker for
// workspace-scoped resources that don't belong to any single conversation.
const GLOBAL_RESOURCE_KINDS: string[] = ['desktop.focus', 'briefing']

// Active subscriptions keyed by `${sessionKey}:${kind}` → subscriptionId.
// Prevents double-subscribing when engine_command_registry fires more than
// once for the same session (e.g. after extension respawn).
const resourceSubscriptionIds = new Map<string, string>()

export async function subscribeToResourceKinds(key: string): Promise<void> {
  for (const kind of SUBSCRIBED_RESOURCE_KINDS) {
    const subKey = `${key}:${kind}`
    if (resourceSubscriptionIds.has(subKey)) {
      log(`resource_subscribe: already subscribed key=${key} kind=${kind} — skipping`)
      continue
    }
    log(`resource_subscribe: key=${key} kind=${kind}`)
    const result = await engineBridge.request<{ subscriptionId: string }>(
      'resource_subscribe',
      { key, resourceKind: kind },
    )
    if (result.ok && result.data?.subscriptionId) {
      resourceSubscriptionIds.set(subKey, result.data.subscriptionId)
      log(`resource_subscribe: ok key=${key} kind=${kind} subId=${result.data.subscriptionId}`)
    } else {
      log(`resource_subscribe: no producer key=${key} kind=${kind} err=${result.error ?? 'no data'}`)
    }
  }
}

export async function subscribeToGlobalResourceKinds(): Promise<void> {
  for (const kind of GLOBAL_RESOURCE_KINDS) {
    const subKey = `global:${kind}`
    if (resourceSubscriptionIds.has(subKey)) {
      log(`resource_subscribe_global: already subscribed kind=${kind} — skipping`)
      continue
    }
    log(`resource_subscribe_global: kind=${kind}`)
    const result = await engineBridge.request<{ subscriptionId: string }>(
      'resource_subscribe',
      { key: '', resourceKind: kind, resourceGlobal: true },
    )
    if (result.ok && result.data?.subscriptionId) {
      resourceSubscriptionIds.set(subKey, result.data.subscriptionId)
      log(`resource_subscribe_global: ok kind=${kind} subId=${result.data.subscriptionId}`)
    } else {
      log(`resource_subscribe_global: failed kind=${kind} err=${result.error ?? 'no data'}`)
    }
  }
}

// ── Tab focus resource publishing ─────────────────────────────────────────
//
// When the user switches tabs, the renderer calls notifyTabFocus(tabId).
// The main process publishes the focused session key as a workspace-scoped
// resource (kind: "desktop.focus") through the engine's resource_publish
// command. Extensions subscribe to this resource to know which session
// the user is currently viewing.

const focusResourceId = `focus-${Date.now()}`

function publishTabFocus(tabId: string): void {
  const sessionKey = tabId
  log(`desktop.focus: publishing tabId=${tabId} sessionKey=${sessionKey}`)

  engineBridge.request('resource_publish', {
    key: '',
    resourceKind: 'desktop.focus',
    resourceGlobal: true,
    resourceOp: 'update',
    resourceItem: {
      id: focusResourceId,
      kind: 'desktop.focus',
      content: JSON.stringify({ focusedSessionKey: sessionKey, focusedTabId: tabId }),
      createdAt: new Date().toISOString(),
    },
  }).catch((err: unknown) => {
    log(`desktop.focus: publish failed err=${err}`)
  })
}

export function wireTabFocusHandler(): void {
  ipcMain.on(IPC.NOTIFY_TAB_FOCUS, (_event: Electron.IpcMainEvent, { tabId }: { tabId: string }) => {
    publishTabFocus(tabId)
  })
}

// ── Mark-read publishing ────────────────────────────────────────────────────
//
// When the user opens a briefing on desktop, the renderer calls
// markResourceRead via the preload bridge. The main process publishes a
// mark_read delta back to the engine so all other subscribers (e.g. iOS)
// see the item as read.

export async function publishResourceMarkRead(kind: string, resourceId: string): Promise<void> {
  log(`resource: mark_read kind=${kind} id=${resourceId}`)
  await engineBridge.request('resource_publish', {
    key: '',
    resourceKind: kind,
    resourceGlobal: true,
    resourceOp: 'mark_read',
    resourceItem: { id: resourceId, kind, content: '', createdAt: '' },
  }).catch((err: unknown) => {
    log(`resource_mark_read: failed kind=${kind} id=${resourceId} err=${err}`)
  })
}

export function wireMarkResourceReadHandler(): void {
  ipcMain.on(IPC.MARK_RESOURCE_READ, (_event: Electron.IpcMainEvent, { kind, resourceId }: { kind: string; resourceId: string }) => {
    publishResourceMarkRead(kind, resourceId).catch(() => {})
  })
}

// ── Delete resource publishing ──────────────────────────────────────────────
//
// When the user deletes a resource on desktop, the renderer calls
// publishResourceDelete via the preload bridge. The main process publishes a
// delete op back to the engine so all other subscribers (e.g. iOS) remove
// the item.

export async function publishResourceDelete(kind: string, resourceId: string): Promise<void> {
  log(`resource: delete kind=${kind} id=${resourceId}`)
  await engineBridge.request('resource_publish', {
    key: '',
    resourceKind: kind,
    resourceGlobal: true,
    resourceOp: 'delete',
    resourceItem: { id: resourceId, kind, content: '', createdAt: '' },
  }).catch((err: unknown) => {
    log(`resource_delete: failed kind=${kind} id=${resourceId} err=${err}`)
  })
}

export function wireDeleteResourceHandler(): void {
  ipcMain.on(IPC.DELETE_RESOURCE, (_event: Electron.IpcMainEvent, { kind, resourceId }: { kind: string; resourceId: string }) => {
    publishResourceDelete(kind, resourceId).catch(() => {})
  })
}
