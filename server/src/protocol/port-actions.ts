/**
 * `port.*` `studio_action`s — the request half of a Port Forward
 * (`@ion/shared/port-forward`). The bytes themselves ride the `PORT_*` binary
 * channels (`terminal-channel.ts`).
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * `terminal:operate`. A Port Forward reaches whatever answers on this host's
 * loopback, which is exactly what a shell in a Terminal here can already
 * reach, so it asks for the same scope a Terminal does and no less.
 */
import type { PortOpenRequest } from '@ion/shared/port-forward'
import { openPortStream } from '../port-forward/port-streams'
import { describePortListeners } from '../port-forward/listeners'
import { listLocalListeners } from '../terminal/terminal-application-discovery'
import { terminalManager } from '../terminal/terminal-manager-instance'
import { tabOwnedBySubject } from './tabs-index'
import { log as _log, warn as _warn } from '../logger'
import type { TerminalActionSpec } from './terminal-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('port-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('port-actions', msg, fields)
}

export const PORT_ACTIONS: Record<string, TerminalActionSpec> = {
  'port.open': {
    requiredScope: 'terminal:operate',
    handler: async (conn, args) => {
      const request = (args[0] ?? {}) as Partial<PortOpenRequest>
      const outcome = await openPortStream(conn, request.streamId, request.port)
      return outcome.ok ? { ok: true, value: null } : { ok: false, error: { code: outcome.code, message: outcome.message } }
    },
  },
  'port.listeners': {
    requiredScope: 'terminal:operate',
    handler: async (conn) => {
      try {
        const subject = conn.principal?.subject ?? null
        const listeners = describePortListeners(await listLocalListeners(), terminalManager.activitySnapshot(), (tabId) => tabOwnedBySubject(tabId, subject))
        log('port listeners listed', { connection_id: conn.id, count: listeners.length })
        return { ok: true, value: listeners }
      } catch (err) {
        warn('port listeners could not be listed', { connection_id: conn.id, error: String(err) })
        return { ok: false, error: { code: 'listeners_unavailable', message: String(err) } }
      }
    },
  },
}
