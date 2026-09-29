/**
 * push-doorbell -- ringing a thin client that is not connected.
 *
 * A thin client that is attached gets the event itself. One that is not has
 * no connection to send on, but its relay channel is still held open by the
 * server (`protocol/relay-listener.ts`), and a relay sends a push
 * notification for a frame it cannot forward when that frame's envelope asks
 * for one. So a push is one sealed doorbell frame per offline mobile client,
 * handed to whoever holds the relay channels.
 *
 * This module is the seam between the two: `remote-out.ts` rings, the relay
 * listener registers itself as the ringer. It imports neither, which keeps
 * the listener's import graph off every event producer.
 */
import type { RelayPushMeta } from '@ion/shared/studio-wire/relay-envelope'
import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('thin-view', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

/** Rings every offline mobile client. Returns how many relay channels carried the doorbell. */
export type PushRinger = (push: RelayPushMeta) => number

let ringer: PushRinger | null = null

/** Installed by the relay listener when it starts, removed (null) when it closes. */
export function setPushRinger(next: PushRinger | null): void {
  ringer = next
  log('push ringer changed', { installed: next !== null })
}

/** Ring every thin client that has no live connection. A no-op, logged, when no relay listener runs. */
export function ringOfflineThinClients(push: RelayPushMeta): void {
  if (!ringer) {
    debug('push not rung: no relay listener is running', { tab_id: push.pushTabId ?? '', kind: push.notifyKind ?? '' })
    return
  }
  const channels = ringer(push)
  log('push rung for offline thin clients', { channel_count: channels, tab_id: push.pushTabId ?? '', kind: push.notifyKind ?? '' })
}
