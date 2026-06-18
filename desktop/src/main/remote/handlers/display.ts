import { log as _log } from '../../logger'
import { state } from '../../state'
import { readSettings, writeSettings } from '../../settings-store'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Per-desktop display override (`remoteDisplay`) — a single record per desktop,
 * shared across every paired iOS device. Owned by the desktop's settings
 * blob; the desktop is the source of truth.
 *
 * Two write paths funnel through `setRemoteDisplay` below:
 *   1. iOS `set_remote_display` command (via `handleSetRemoteDisplay`).
 *   2. Desktop renderer IPC `ion:remote-set-display` (via remote-control.ts).
 *
 * Both paths apply Last-Write-Wins on `updatedAt`. On accept the desktop
 * broadcasts `remote_display` to every connected paired phone. On reject
 * (stale write) the desktop sends `remote_display` back to the sender only,
 * with the current authoritative values, so the sender reconciles.
 */

export interface RemoteDisplayValue {
  customName: string | null
  customIcon: string | null
  updatedAt: number
}

const ICON_IDENTIFIERS = new Set([
  'desktop', 'laptop', 'macmini', 'macpro', 'display',
  'server', 'terminal', 'briefcase', 'house', 'gamepad',
])

/** Read the current remoteDisplay record from settings (returns null when unset). */
export function readRemoteDisplay(): RemoteDisplayValue | null {
  const settings = readSettings()
  const rd = settings.remoteDisplay
  if (!rd || typeof rd !== 'object') return null
  const updatedAt = typeof rd.updatedAt === 'number' ? rd.updatedAt : 0
  const customName = typeof rd.customName === 'string' && rd.customName.trim().length > 0
    ? rd.customName.trim()
    : null
  const customIcon = typeof rd.customIcon === 'string' && ICON_IDENTIFIERS.has(rd.customIcon)
    ? rd.customIcon
    : null
  log(`DISPLAY-READ: name=${customName === null ? 'null' : 'set'} icon=${customIcon ?? 'null'} ts=${updatedAt}`)
  return { customName, customIcon, updatedAt }
}

/**
 * Apply a remoteDisplay write. Single source of truth for both iOS and the
 * desktop UI. Returns the value that is now authoritative on the desktop —
 * either the incoming value (accepted) or the existing value (rejected).
 *
 * `source` is included in log lines so we can tell which edit path wrote.
 * `sourceDeviceId` (optional) identifies the iOS phone for iOS-originated
 * writes, so the broadcast log can attribute the change to it.
 */
export function setRemoteDisplay(
  customName: string | null,
  customIcon: string | null,
  updatedAt: number,
  source: 'ios' | 'desktop',
  sourceDeviceId?: string,
): { applied: boolean; value: RemoteDisplayValue } {
  const sourceTag = source === 'ios' ? `ios device=${(sourceDeviceId ?? '?').slice(0, 8)}` : 'desktop'
  const stored = readRemoteDisplay()

  // Normalize incoming: trim/empty → null; unknown icon → null.
  const normalizedName = typeof customName === 'string' && customName.trim().length > 0
    ? customName.trim()
    : null
  const normalizedIcon = typeof customIcon === 'string' && ICON_IDENTIFIERS.has(customIcon)
    ? customIcon
    : (customIcon === null ? null : null) // unknown → null
  if (customIcon !== null && customIcon !== undefined && !ICON_IDENTIFIERS.has(customIcon)) {
    log(`DISPLAY-SET: ${sourceTag} unknown icon "${customIcon}" — coercing to null`)
  }

  // LWW: accept only when incoming is at least as new as stored.
  if (stored && updatedAt < stored.updatedAt) {
    log(`DISPLAY-SET: stale ${sourceTag} incoming=${updatedAt} stored=${stored.updatedAt} — rejecting`)
    // Reply to the sender only (if known) so they reconcile.
    if (source === 'ios' && sourceDeviceId) {
      log(`DISPLAY-RECONCILE: device=${sourceDeviceId.slice(0, 8)} sending current ts=${stored.updatedAt}`)
      state.remoteTransport?.sendToDevice(sourceDeviceId, {
        type: 'desktop_remote_display',
        customName: stored.customName,
        customIcon: stored.customIcon,
        updatedAt: stored.updatedAt,
      })
    }
    return { applied: false, value: stored }
  }

  // Accept and persist.
  const nextValue: RemoteDisplayValue = {
    customName: normalizedName,
    customIcon: normalizedIcon,
    updatedAt,
  }
  const settings = readSettings()
  settings.remoteDisplay = nextValue
  writeSettings(settings)
  log(`DISPLAY-SET: ${sourceTag} name=${normalizedName === null ? 'cleared' : 'set'} icon=${normalizedIcon ?? 'cleared'} ts=${updatedAt} prevTs=${stored?.updatedAt ?? 0}`)

  // Notify the renderer too so the desktop Settings UI updates without
  // round-tripping through a separate file read on next open. The renderer
  // store also writes to disk via saveSettings, so reflect-back is
  // idempotent: we write the merged settings here, the renderer Zustand
  // then no-ops on the next save attempt.
  try {
    state.mainWindow?.webContents.send('ion:remote-display-changed', nextValue)
  } catch (err) {
    log(`DISPLAY-NOTIFY: renderer notify failed: ${(err as Error).message}`)
  }

  // Broadcast to every connected paired phone (including the sender, which
  // treats the echo as a confirm ack).
  const connectedIds = state.remoteTransport?.getConnectedDeviceIds?.() ?? []
  log(`DISPLAY-BROADCAST: n=${connectedIds.length} ts=${updatedAt}`)
  state.remoteTransport?.send({
    type: 'desktop_remote_display',
    customName: normalizedName,
    customIcon: normalizedIcon,
    updatedAt,
  })

  return { applied: true, value: nextValue }
}

/** Wire-level handler for the `set_remote_display` command from iOS. */
export async function handleSetRemoteDisplay(
  cmd: Extract<RemoteCommand, { type: 'desktop_set_remote_display' }>,
  deviceId: string,
): Promise<void> {
  log(`DISPLAY-CMD: from device=${deviceId.slice(0, 8)} name=${cmd.customName === null ? 'null' : 'set'} icon=${cmd.customIcon ?? 'null'} ts=${cmd.updatedAt}`)
  if (typeof cmd.updatedAt !== 'number' || cmd.updatedAt <= 0) {
    log(`DISPLAY-CMD: rejecting device=${deviceId.slice(0, 8)} — invalid updatedAt=${cmd.updatedAt}`)
    return
  }
  setRemoteDisplay(cmd.customName, cmd.customIcon, cmd.updatedAt, 'ios', deviceId)
}
