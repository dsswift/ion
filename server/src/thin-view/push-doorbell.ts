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
import { withSpan } from '../tracing/op-span'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('thin-view', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

/**
 * Rings every offline mobile client. Returns how many relay channels carried
 * the doorbell. `traceparent` is the `push.ring` span, set on each doorbell
 * envelope so the relay's push and the phone's `push.open` join its trace.
 */
export type PushRinger = (push: RelayPushMeta, traceparent: string) => number

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
  withSpan('push.ring', { kind: 'client', attrs: { tab_id: push.pushTabId ?? '', kind: push.notifyKind ?? '' } }, (span, ctx) => {
    const channels = ringer!(push, span.traceparent)
    ctx.annotate({ channel_count: channels })
    log('push rung for offline thin clients', { channel_count: channels, tab_id: push.pushTabId ?? '', kind: push.notifyKind ?? '' })
  })
}
