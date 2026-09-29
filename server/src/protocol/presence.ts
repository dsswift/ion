/**
 * FR-02 presence: who is connected, which tab each connection has focused,
 * and which tab (if any) each connection is currently DRIVING -- has an
 * in-flight run they started still running.
 *
 * Emitted on the `studio:presence` channel (`'environment'` scope --
 * `@ion/shared/studio-wire/channels.ts`), a full snapshot on every change,
 * to every connected client regardless of tenancy mode. In `'isolated'`
 * mode the snapshot still carries every connection's presence entry (not
 * just the caller's own) -- presence is who else is here, which is exactly
 * the thing isolated mode is meant to hide about TABS, not about people;
 * see the plan's "isolated mode carries only the caller's own subject" note
 * for `list_sessions`, a narrower and unrelated leak-surface. Also included
 * on `studio_welcome`'s `StudioSnapshot.presence` so a freshly-connected
 * client has it before the first broadcast.
 */
import type { Connection } from './connection'
import { connectionRegistry } from './connection'
import type { PresenceEntry, PresenceSnapshot } from '@ion/shared/types-presence'
import { broadcast } from '../broadcast'
import { sessionPlane, deviceFocusMap } from '../state'
import { focusState } from '../git/focus-state'
import { getPairedDeviceById } from '../remote/paired-device-lookup'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('presence', msg, fields)
}

/** Per-connection focus state, keyed by `Connection.id`. Populated on auth success, removed on disconnect. */
const focusedTabByConnection = new Map<string, string | null>()

/**
 * Per-connection attention (`presence.attention`): whether that client's
 * window is focused. Background git work is gated on ANY attentive consumer
 * (`git/focus-state.ts`), so one focused browser tab keeps the watchers
 * alive while the desktop is backgrounded, and a connection that drops
 * takes its attention with it. The desktop used to set this directly from
 * its own window focus; every client reports it the same way now.
 */
const attentionByConnection = new Map<string, boolean>()

function recomputeAttention(): void {
  focusState.setFocused([...attentionByConnection.values()].some(Boolean))
}

/** `presence.attention` action: this connection's window focus. */
export function setAttention(conn: Connection, focused: boolean): void {
  attentionByConnection.set(conn.id, focused)
  recomputeAttention()
  log('attention reported', { connection_id: conn.id, focused, attentive_connections: [...attentionByConnection.values()].filter(Boolean).length })
}

/** `tabId -> subject` for whoever most recently started a still-running turn on it. Cleared when the tab leaves `'running'`. */
const drivingByTab = new Map<string, string>()

/** Called once a connection's principal is resolved (hello.ts, post-auth). */
export function registerPresence(conn: Connection): void {
  if (!conn.principal) return
  focusedTabByConnection.set(conn.id, null)
  log('connection registered', { connection_id: conn.id, subject: conn.principal.subject })
  broadcastPresence()
}

/** Called on connection close (listener.ts). */
export function unregisterPresence(conn: Connection): void {
  if (attentionByConnection.delete(conn.id)) recomputeAttention()
  if (!focusedTabByConnection.delete(conn.id)) return
  log('connection unregistered', { connection_id: conn.id })
  broadcastPresence()
}

/** `presence.focus` action: the connection's own tab focus, or null to clear it. */
export function setFocusedTab(conn: Connection, tabId: string | null): void {
  if (!conn.principal || !focusedTabByConnection.has(conn.id)) return
  focusedTabByConnection.set(conn.id, tabId)
  broadcastPresence()
}

/** The tab `conn` last reported as focused, or null. */
export function focusedTabOf(conn: Connection): string | null {
  return focusedTabByConnection.get(conn.id) ?? null
}

/** Marks `subject` as driving `tabId` -- called when `submitRemotePrompt` starts a turn (`protocol/actions.ts`). */
export function setDriving(tabId: string, subject: string): void {
  drivingByTab.set(tabId, subject)
  broadcastPresence()
}

function clearDriving(tabId: string): void {
  if (!drivingByTab.delete(tabId)) return
  broadcastPresence()
}

/**
 * Subscribes to the control plane's tab-status transitions so a tab leaving
 * `'running'` (completed, idle, waiting -- any non-running state) clears its
 * driving entry. Call once at boot (`main.ts`).
 */
export function wirePresenceDrivingTracking(): void {
  sessionPlane.on('tab-status-change', (tabId: string, newStatus: string) => {
    if (newStatus !== 'running') clearDriving(tabId)
  })
}

/**
 * Remote (iOS) devices' presence entries, derived from `deviceFocusMap`
 * (`state.ts` -- populated by the existing `desktop_report_focus` command,
 * the remote-device counterpart of the studio-wire `presence.focus` action)
 * cross-referenced against the paired-device registry for the attributed
 * principal and display name. A device with no `principalSubject` (no
 * principal partitioning configured) has nothing to attribute and is
 * omitted -- there is no studio Connection for a remote device, so this is
 * the only place its presence can be observed.
 */
function remotePresenceEntries(): PresenceEntry[] {
  const entries: PresenceEntry[] = []
  for (const [deviceId, focus] of deviceFocusMap) {
    const device = getPairedDeviceById(deviceId)
    if (!device?.principalSubject) continue
    entries.push({ subject: device.principalSubject, displayName: device.name, focusedTabId: focus.tabId })
  }
  return entries
}

/** The full presence list -- every registered studio connection AND remote device's principal and current focus. */
export function presenceSnapshot(): PresenceEntry[] {
  const studioEntries = connectionRegistry
    .all()
    .filter((conn) => conn.principal && focusedTabByConnection.has(conn.id))
    .map((conn) => ({
      subject: conn.principal!.subject,
      displayName: conn.principal!.displayName,
      focusedTabId: focusedTabByConnection.get(conn.id) ?? null,
    }))
  return [...studioEntries, ...remotePresenceEntries()]
}

/** `tabId -> subject` for every tab currently being driven, suitable for merging onto per-tab snapshot state. */
export function drivingMap(): Record<string, string> {
  return Object.fromEntries(drivingByTab)
}

/** The wire payload for `studio:presence` and `StudioSnapshot.presence` -- entries plus the driving map. */
export function fullPresenceSnapshot(): PresenceSnapshot {
  return { entries: presenceSnapshot(), driving: drivingMap() }
}

function broadcastPresence(): void {
  broadcast('studio:presence', fullPresenceSnapshot())
}

/**
 * Re-broadcasts presence after a remote device's focus changes
 * (`desktop_report_focus`, `command-handler.ts`) or a device is unpaired
 * (`transport-init.ts`) -- both mutate `deviceFocusMap` directly rather than
 * through this module's own registration functions, so they call this to
 * fan the change out the same way `setFocusedTab`/`unregisterPresence` do
 * for a studio connection.
 */
export function refreshRemotePresence(): void {
  broadcastPresence()
}

/** TEST ONLY. Clears both module-level maps between test cases. */
export function _resetPresenceForTest(): void {
  attentionByConnection.clear()
  focusState.setFocused(true)
  focusedTabByConnection.clear()
  drivingByTab.clear()
}
