/**
 * `remote.*` `studio_action`s: control of this Environment's device
 * transport (iOS / LAN / relay) from a Studio client.
 *
 * Every verb here was an Electron `ipcMain` handler with zero Electron API
 * in its body; they moved with the transport they control. The Remote
 * settings category reaches them through the bridged shell on every host.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Relay testing, relay discovery and the relay auth probe configure how this
 * Environment reaches its devices, which changes what it does for every
 * client, so they are `admin`. They are not confined to the local desktop: a
 * server with no desktop attached is administered from a phone or a browser,
 * and an admin there must be able to set up the relay the same way. Local
 * connections hold every scope (`hello.ts`). `remote.getDisplay` is
 * `conversations:read`.
 */
import { IPC } from '@ion/shared/types'
import type { Scope } from '@ion/shared/studio-wire/types'
import { log as _log, warn as _warn } from '../logger'
import { relayDiscovery } from '../state'
import type { DiscoveredRelay } from '../remote/discovery'
import { broadcast } from '../broadcast'
import { setRemoteDisplay, readRemoteDisplay } from '../remote/handlers/display'
import { probeRelayAuthConfig } from '../remote/relay-auth'
import type { MiscActionSpec } from './misc-actions'
import type { Connection } from './connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('remote-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('remote-actions', msg, fields)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function wrap(
  name: string,
  requiredScope: Scope,
  run: (conn: Connection, args: unknown[]) => unknown | Promise<unknown>,
): MiscActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(conn, args)) ?? null }
      } catch (err) {
        warn('remote action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

/** One relay socket open/close against `relayUrl`, bounded at five seconds. */
export async function testRelay(relayUrl: string, relayApiKey: string): Promise<{ success: boolean; error?: string }> {
  const WebSocket = (await import('ws')).default
  return new Promise((resolve) => {
    try {
      const base = relayUrl.replace(/\/+$/, '')
      const ws = new WebSocket(`${base}/v1/channel/_test?role=ion`, { headers: { Authorization: `Bearer ${relayApiKey}` } })
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, error: 'Connection timed out' })
      }, 5000)
      ws.on('open', () => {
        clearTimeout(timeout)
        ws.close()
        resolve({ success: true })
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        resolve({ success: false, error: (err as Error).message })
      })
    } catch (err) {
      resolve({ success: false, error: (err as Error).message })
    }
  })
}

/**
 * Relay discovery is asynchronous: the action below answers with whatever has
 * been found so far, and everything found afterwards arrives on
 * `REMOTE_RELAYS_CHANGED`. Without this listener the channel has no producer
 * and a relay discovered a second after the action returns never reaches the
 * settings panel that asked for it.
 *
 * Armed here rather than at boot because this action is the only thing that
 * starts browsing, so there is no ordering to get wrong and nothing to
 * remember in `main.ts`. Idempotent: `remote.stopDiscovery` and a later
 * `remote.discoverRelays` must not stack a second listener onto the emitter.
 */
let relayDiscoveryBroadcastArmed = false

function armRelayDiscoveryBroadcast(): void {
  if (relayDiscoveryBroadcastArmed) return
  relayDiscoveryBroadcastArmed = true
  relayDiscovery.on('relays-changed', (relays: DiscoveredRelay[]) => {
    log('relay discovery: fanning results to clients', { relay_count: relays.length })
    broadcast(IPC.REMOTE_RELAYS_CHANGED, relays)
  })
  log('relay discovery broadcast armed')
}

/** TEST ONLY: forget that the listener was armed. */
export function _resetRelayDiscoveryBroadcastForTest(): void {
  relayDiscoveryBroadcastArmed = false
}

export const REMOTE_ACTIONS: Record<string, MiscActionSpec> = {
  // [customName, customIcon, updatedAt?] -> the value now authoritative here.
  //
  // How this server names itself is shown to, and edited from, every client
  // that operates its conversations, so this is `conversations:operate` and
  // not confined to the local desktop. `updatedAt` is the editor's own clock
  // reading: the newest edit wins, and an edit older than the stored one is
  // answered with the stored value so the editor reconciles to it. Absent, the
  // edit is stamped on arrival and always wins.
  'remote.setDisplay': wrap('remote.setDisplay', 'conversations:operate', (conn, a) => {
    const customName = typeof a[0] === 'string' ? a[0] : null
    const customIcon = typeof a[1] === 'string' ? a[1] : null
    if (a[2] !== undefined && a[2] !== null && !(typeof a[2] === 'number' && a[2] > 0)) {
      log('set display refused: updatedAt is not a positive number', { connection_id: conn.id })
      throw new Error('updatedAt must be a positive number of milliseconds')
    }
    const updatedAt = typeof a[2] === 'number' ? a[2] : Date.now()
    log('set display', { connection_id: conn.id, has_name: customName !== null, icon: customIcon ?? '', client_stamped: typeof a[2] === 'number' })
    const result = setRemoteDisplay(customName, customIcon, updatedAt, 'desktop')
    // Every open Studio client renders the Remote category; the edit reaches
    // them all rather than waiting on each one's next disk read.
    if (result.applied) broadcast(IPC.REMOTE_DISPLAY_CHANGED, result.value)
    else log('set display lost to a newer edit', { connection_id: conn.id, incoming_ts: updatedAt, stored_ts: result.value.updatedAt })
    return result.value
  }),

  'remote.getDisplay': wrap('remote.getDisplay', 'conversations:read', () => readRemoteDisplay()),

  'remote.discoverRelays': wrap('remote.discoverRelays', 'admin', () => {
    armRelayDiscoveryBroadcast()
    relayDiscovery.startBrowsing()
    return relayDiscovery.relays
  }),

  'remote.stopDiscovery': wrap('remote.stopDiscovery', 'admin', () => {
    relayDiscovery.stopBrowsing()
    return null
  }),

  'remote.testRelay': wrap('remote.testRelay', 'admin', (_conn, a) => testRelay(str(a[0]), str(a[1]))),

  // The relay's auth config, so the UI can adapt without a full connect.
  'remote.relayAuthConfig': wrap('remote.relayAuthConfig', 'admin', (_conn, a) => probeRelayAuthConfig(str(a[0]))),
}
