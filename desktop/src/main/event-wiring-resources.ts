// Resource subscription and tab-focus publishing for the engine bridge.
//
// Extracted from event-wiring.ts to keep that file under the 600-line cap.
// This module handles:
//   - Per-session resource subscriptions (wildcard — every kind)
//   - Global resource subscriptions (wildcard — every workspace kind)
//   - Tab focus publishing (desktop.focus resource on tab switch)
//   - Read-state persistence to disk (~/.ion/resource-read-state.json)

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { log as _log } from './logger'
import { engineBridge } from './state'

function log(msg: string): void {
  _log('main', msg)
}

// ── Active session key tracking ────────────────────────────────────────────
//
// Tracks session keys (tabId:instanceId) that have successfully subscribed to
// per-session resource kinds. Persists across clearResourceSubscriptions() so
// that on engine reconnect (desktop restart connecting to a running engine),
// resubscribeSessionResourceKinds() can re-establish per-session subscriptions
// for all active sessions without waiting for engine_command_registry (which
// only fires on initial session creation, not on reconnect).
const activeSessionKeys = new Set<string>()

/** Register a session key as active. Called after a successful per-session
 *  resource subscription so the key survives reconnect cycles. */
export function recordActiveSessionKey(key: string): void {
  activeSessionKeys.add(key)
}

/** Re-subscribe to per-session resource kinds for all known active session keys.
 *  Called after clearResourceSubscriptions() on engine reconnect to recover
 *  subscriptions that would otherwise wait for engine_command_registry. */
export async function resubscribeSessionResourceKinds(): Promise<void> {
  if (activeSessionKeys.size === 0) {
    log('resource_subscribe: no active session keys to resubscribe')
    return
  }
  log(`resource_subscribe: resubscribing ${activeSessionKeys.size} active session key(s) after reconnect`)
  const keys = Array.from(activeSessionKeys)
  await Promise.allSettled(
    keys.map((key) =>
      subscribeToResourceKinds(key).catch((err) => {
        log(`resource_subscribe: resubscribe error key=${key} err=${err}`)
      }),
    ),
  )
}

// ── Read-state persistence ────────────────────────────────────────────────
//
// The desktop persists which resource IDs the user has read to disk so
// read state survives app restarts. The engine has no concept of read/unread.
// This is purely a client-side rendering concern.

const READ_STATE_PATH = join(homedir(), '.ion', 'resource-read-state.json')

/** IDs the user has read. Loaded from disk on module init, written on every change. */
const persistedReadIds: Set<string> = new Set<string>()

// Load from disk on startup
try {
  if (existsSync(READ_STATE_PATH)) {
    const data = JSON.parse(readFileSync(READ_STATE_PATH, 'utf-8'))
    if (Array.isArray(data)) {
      for (const id of data) persistedReadIds.add(id)
      log(`resource-read-state: loaded ${persistedReadIds.size} read IDs from disk`)
    }
  }
} catch { /* non-fatal: start fresh */ }

function persistReadState(): void {
  try {
    mkdirSync(join(homedir(), '.ion'), { recursive: true })
    writeFileSync(READ_STATE_PATH, JSON.stringify([...persistedReadIds]))
  } catch { /* non-fatal */ }
}

/** Mark a resource as read and persist to disk. */
export function markReadPersisted(resourceId: string): void {
  persistedReadIds.add(resourceId)
  persistReadState()
}

/** Check if a resource ID has been read. Used by the snapshot builder. */
export function isResourceRead(resourceId: string): boolean {
  return persistedReadIds.has(resourceId)
}

// ── Resource subscription ──────────────────────────────────────────────────
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
const WILDCARD_RESOURCE_KIND = '*'

// Active subscriptions keyed by `${sessionKey}:${kind}` → subscriptionId.
// Prevents double-subscribing when engine_command_registry fires more than
// once for the same session (e.g. after extension respawn).
const resourceSubscriptionIds = new Map<string, string>()

/** Clear subscription tracking on engine reconnect. Old subscription IDs
 *  are stale after a reconnect (the engine assigned new ones). Without
 *  clearing, subscribeToResourceKinds skips every kind because the dedup
 *  map still holds entries from the dead connection. */
export function clearResourceSubscriptions(): void {
  resourceSubscriptionIds.clear()
}

export async function subscribeToResourceKinds(key: string): Promise<void> {
  const kind = WILDCARD_RESOURCE_KIND
  const subKey = `${key}:${kind}`
  if (resourceSubscriptionIds.has(subKey)) {
    log(`resource_subscribe: already wildcard-subscribed key=${key} — skipping`)
    return
  }
  log(`resource_subscribe: wildcard key=${key} kind=${kind}`)
  const result = await engineBridge.request<{ subscriptionId: string }>(
    'resource_subscribe',
    { key, resourceKind: kind },
  )
  if (result.ok && result.data?.subscriptionId) {
    resourceSubscriptionIds.set(subKey, result.data.subscriptionId)
    // Track this key so it can be resubscribed on engine reconnect.
    recordActiveSessionKey(key)
    log(`resource_subscribe: ok key=${key} kind=${kind} subId=${result.data.subscriptionId}`)
  } else {
    log(`resource_subscribe: failed key=${key} kind=${kind} err=${result.error ?? 'no data'}`)
  }
}

export async function subscribeToGlobalResourceKinds(): Promise<void> {
  const kind = WILDCARD_RESOURCE_KIND
  const subKey = `global:${kind}`
  if (resourceSubscriptionIds.has(subKey)) {
    log(`resource_subscribe_global: already wildcard-subscribed — skipping`)
    return
  }
  log(`resource_subscribe_global: wildcard kind=${kind}`)
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
// When the user opens a resource on desktop, the renderer calls
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
    markReadPersisted(resourceId)
    publishResourceMarkRead(kind, resourceId).catch(() => {})
  })
  ipcMain.handle(IPC.GET_READ_RESOURCE_IDS, () => {
    return [...persistedReadIds]
  })
  ipcMain.handle(IPC.GET_PERSISTED_RESOURCES, () => {
    // Cold-load ALL resources from disk (global + conversation-scoped)
    // so the renderer has data immediately, even if engine subscriptions
    // fail or return empty.
    const resourcesRoot = join(homedir(), '.ion', 'resources')
    type PersistedItem = { id: string; kind: string; title?: string; content: string; createdAt: string; conversationId?: string; metadata?: Record<string, unknown>; read?: boolean }
    const items: PersistedItem[] = []
    try {
      if (!existsSync(resourcesRoot)) {
        log('resource: cold-load: resources dir does not exist')
        return items
      }
      const subdirs = readdirSync(resourcesRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
      for (const subdir of subdirs) {
        const dirPath = join(resourcesRoot, subdir.name)
        try {
          const files = readdirSync(dirPath).filter(f => f.endsWith('.json'))
          for (const f of files) {
            try {
              const data = JSON.parse(readFileSync(join(dirPath, f), 'utf-8'))
              if (data.id && data.kind) {
                items.push({
                  id: data.id,
                  kind: data.kind,
                  title: data.title,
                  content: data.content ?? '',
                  createdAt: data.createdAt ?? '',
                  conversationId: data.conversationId,
                  metadata: data.metadata,
                  read: isResourceRead(data.id),
                })
              }
            } catch { /* skip corrupt files */ }
          }
        } catch { /* skip unreadable directories */ }
      }
    } catch { /* non-fatal */ }
    const globalCount = items.filter(i => !i.conversationId).length
    const scopedCount = items.filter(i => !!i.conversationId).length
    log(`resource: cold-load from disk: ${items.length} total (${globalCount} global, ${scopedCount} conversation-scoped)`)
    return items
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
