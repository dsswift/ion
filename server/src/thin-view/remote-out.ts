/**
 * remote-out -- the one funnel for a `RemoteEvent` leaving the server.
 *
 * A `RemoteEvent` is the server-derived view of an Environment: transcript
 * rows built from engine tool events, batched text deltas, tab and worktree
 * state, settings, themes, questions. Two kinds of client render it:
 *
 *  - a thin Studio-wire connection (`studio_hello.view === 'thin'`), on the
 *    `studio:thin-event` channel, where `protocol/events.ts` applies the view
 *    gate and the per-tab ownership rule every other tab-scoped channel gets.
 *
 * Every producer calls `sendRemoteEvent` instead of reaching for the
 * transport, so both kinds of client see the same events from the same code
 * and neither can be forgotten at a call site. A producer that skips work
 * when nobody is listening asks `remoteClientsPresent`.
 *
 * A push rides both wires. The `desktop_*` transport marks its own frame. A
 * thin client that is attached needs no push; one that is not is rung through
 * its relay channel (`push-doorbell.ts`).
 */
import { THIN_EVENT_CHANNEL } from '@ion/shared/studio-wire/channels'
import { connectionRegistry, type Connection } from '../protocol/connection'
import { publishStudioEvent } from '../protocol/events'
import { focusState } from '../git/focus-state'
import { ringOfflineThinClients } from './push-doorbell'
import { debug as _debug } from '../logger'
import type { RemoteEvent } from '../remote/protocol'

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

export interface RemotePushMeta {
  title?: string
  body?: string
  tabId?: string
  /** Deep-link hints a relay copies into the push payload. Carried on the sealed relay envelope only. */
  kind?: string
  resourceId?: string
}

/** Every admitted thin connection that is still open. */
export function thinConnections(): Connection[] {
  return connectionRegistry.all().filter((conn) => conn.view === 'thin' && !conn.isClosed)
}

/** Whether any client that renders `RemoteEvent`s exists right now. */
export function remoteClientsPresent(): boolean {
  return thinConnections().length > 0
}

/**
 * Tell the git focus gate how many clients depend on proactive watcher
 * pushes. A connected phone keeps the watcher awake.
 */
export function syncRemoteAttention(): void {
  const thin = thinConnections().length
  focusState.setRemoteClientCount(thin)
  debug('remote attention synced', { thin_connections: thin })
}

/** Send one event to every client that renders `RemoteEvent`s. */
export function sendRemoteEvent(event: RemoteEvent, push = false, pushMeta?: RemotePushMeta): void {
  publishStudioEvent(THIN_EVENT_CHANNEL, [event])
  if (push) {
    ringOfflineThinClients({ pushTitle: pushMeta?.title, pushBody: pushMeta?.body, pushTabId: pushMeta?.tabId, notifyKind: pushMeta?.kind, notifyResourceId: pushMeta?.resourceId })
  }
}

/**
 * Send one event to a single thin connection, bypassing the fan-out. Used
 * for payloads already built for that connection's principal (its snapshot
 * and first paint), where the ownership rule was applied while building.
 */
export function sendThinEventTo(conn: Connection, event: RemoteEvent | Record<string, unknown>): boolean {
  if (conn.isClosed || conn.view !== 'thin') {
    debug('targeted thin event skipped', { connection_id: conn.id, closed: conn.isClosed, view: conn.view })
    return false
  }
  return conn.send({ type: 'studio_event', channel: THIN_EVENT_CHANNEL, payload: event })
}
