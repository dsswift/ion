/**
 * The `fleet.hubs.*` `studio_action`s: which Fleet Hubs this server reports
 * to, and adding or removing one. Listing needs only `conversations:read`;
 * changing the list is an admin's.
 */
import { normalizeHubUrl } from '@ion/shared/fleet-hub'
import type { EnvironmentActionSpec } from '../environment/actions'
import { fleetHubLinks } from './hub-links'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.hub-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.hub-actions', msg, fields)
}

function first(args: unknown[]): Record<string, unknown> {
  const a = args[0]
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}

/** How long adding a hub waits for the hub's answer before it reports the link as still connecting. */
const ADD_SETTLE_MS = 8_000

const NOT_RUNNING = { ok: false as const, error: { code: 'hubs_unavailable', message: 'This server is not running its hub links yet.' } }

export const FLEET_HUB_ACTIONS: Record<string, EnvironmentActionSpec> = {
  'fleet.hubs.list': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      const links = fleetHubLinks()
      if (!links) return NOT_RUNNING
      const list = links.list()
      log('fleet hubs listed', { connection_id: conn.id, hub_count: list.hubs.length, restricted: list.restricted })
      return { ok: true, value: list }
    },
  },
  'fleet.hubs.add': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const links = fleetHubLinks()
      if (!links) return NOT_RUNNING
      const a = first(args)
      const url = normalizeHubUrl(a.url)
      const enrollmentToken = typeof a.enrollmentToken === 'string' ? a.enrollmentToken.trim() : ''
      if (!url || !enrollmentToken) {
        warn('fleet hub add refused: no address or no enrollment token', { connection_id: conn.id, has_url: !!url, has_token: !!enrollmentToken })
        return { ok: false, refusal: { code: 'invalid_hub', message: 'A hub needs its web address and its enrollment token.' } }
      }
      // The name the person adding the hub knows this server by, so the hub shows the same one.
      const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 120) : undefined
      const outcome = links.add({ url, enrollmentToken, manage: a.manage !== false, label })
      if (!outcome.ok) return { ok: false, refusal: { code: outcome.code, message: outcome.message } }
      // The answer says how joining went, not that it started: an enrollment is decided in a moment.
      await links.settled(url, ADD_SETTLE_MS)
      const list = links.list()
      log('fleet hub added', { connection_id: conn.id, hub_url: url, manage: a.manage !== false, state: list.hubs.find((h) => h.url === url)?.state })
      return { ok: true, value: list }
    },
  },
  'fleet.hubs.remove': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const links = fleetHubLinks()
      if (!links) return NOT_RUNNING
      const url = normalizeHubUrl(first(args).url)
      if (!url || !links.remove(url)) {
        warn('fleet hub remove refused: not a hub added on this server', { connection_id: conn.id, hub_url: url })
        return { ok: false, refusal: { code: 'not_removable', message: 'That hub was not added on this server. A hub your organization set cannot be removed here.' } }
      }
      log('fleet hub removed', { connection_id: conn.id, hub_url: url })
      return { ok: true, value: links.list() }
    },
  },
}
