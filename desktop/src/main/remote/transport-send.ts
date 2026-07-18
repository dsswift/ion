// Outbound send-queue path for RemoteTransport, extracted from transport.ts.
//
// This is the hot path: every engine event the desktop forwards to a paired
// iOS device flows through enqueueSend → drainSendQueue → sendToAll. It was
// lifted out of the RemoteTransport class both to keep transport.ts under the
// file-size cap and to make the drain logic unit-testable in isolation (the
// class methods it replaced could only be exercised through a fully wired
// transport). The functions operate on an explicit SendCtx rather than `this`,
// mirroring the transport-lan-auth.ts helper pattern already used here.

import { log as _log } from '../logger'
import { buildDeviceFrame } from './transport-frame'
import { compressPayload } from './transport-compression'
import { mark, Activity } from '../watchdog'
import type { RemoteEvent, WireMessage } from './protocol'
import type { RetransmitBuffer } from './retransmit-buffer'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

/** Cap on queued-but-undelivered events before backpressure kicks in. */
export const MAX_QUEUE_SIZE = 500

/**
 * Safety valve on the serialized size of a single event, checked before the
 * synchronous stringify→compress→encrypt pipeline. This is deliberately high
 * (32 MB): no legitimate event — snapshot, capped history page, delta — comes
 * close, so it only ever trips on a pathological payload that would otherwise
 * DEFLATE-and-encrypt for many seconds on the main thread (a relay wedge). When
 * it trips, the event is dropped with an error log; iOS recovers state via its
 * periodic snapshot resync. Measured on `String.length` (UTF-16 code units),
 * which is O(1) and close enough to bytes for a ceiling this coarse.
 */
export const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024

/**
 * Event types that must never be silently dropped by backpressure. Delivery is
 * best-effort at the socket layer (a live delta can still be lost in a transport
 * switch); this set prevents the desktop from *choosing* to drop one.
 */
export const CRITICAL_TYPES = new Set([
  'desktop_permission_request', 'desktop_snapshot', 'desktop_tab_created', 'desktop_tab_closed',
  'desktop_conversation_history', 'desktop_heartbeat', 'desktop_terminal_snapshot',
  'desktop_agent_state', 'desktop_status', 'desktop_message_end', 'desktop_engine_error',
  // desktop_user_turn_persisted is the re-key signal that prevents the
  // duplicate-user-bubble bug on cancelled/failed runs; a dropped one
  // silently reintroduces the duplicate on the next history load.
  'desktop_user_turn_persisted',
  // desktop_stream_reset must ride FIFO with desktop_text_delta: a dropped
  // reset leaves the discarded attempt's partial text on the phone as if it
  // were real output.
  'desktop_text_delta', 'desktop_stream_reset', 'desktop_tool_start', 'desktop_tool_end',
])

/** One queued outbound event plus its push metadata and enqueue timestamp. */
export interface SendQueueItem {
  event: RemoteEvent
  push: boolean
  pushTitle?: string
  pushBody?: string
  enqueuedAt: number
}

/**
 * The transport state the send path touches. Passed explicitly so the functions
 * are pure with respect to the transport instance and can be unit tested with a
 * hand-built context.
 *   - sendQueue: mutated in place (push / shift / splice); never reassigned.
 *   - deviceSecrets: deviceId → shared secret for every PAIRED device (a paired
 *     but disconnected device is still present here).
 *   - retransmit: durable replay buffer; every built frame is recorded here
 *     BEFORE delivery, so a frame is preserved for resend even if the live
 *     delivery fails.
 *   - nextSeq: allocates the next monotonic wire sequence number FOR the given
 *     device. Counters are per-device so every device receives a contiguous
 *     1,2,3,... stream (a shared counter strided each device's seqs by the
 *     device count and tripped iOS gap detection on nearly every frame).
 *   - deliverFrame: attempts live delivery to one device; returns true if the
 *     frame reached a connected transport, false if the device is unreachable.
 */
export interface SendCtx {
  sendQueue: SendQueueItem[]
  deviceSecrets: Map<string, Buffer>
  retransmit: RetransmitBuffer
  nextSeq: (deviceId: string) => number
  deliverFrame: (deviceId: string, frame: WireMessage) => boolean
  /** Outbound-seq epoch (generation id) stamped on every built frame. */
  epoch?: number
}

/** Enqueue an event for delivery, applying backpressure, then drain. */
export function enqueueSend(
  ctx: SendCtx,
  event: RemoteEvent,
  push: boolean,
  pushMeta?: { title?: string; body?: string },
): void {
  // If the queue is full, apply backpressure.
  if (ctx.sendQueue.length >= MAX_QUEUE_SIZE) {
    if (!CRITICAL_TYPES.has(event.type)) {
      log('transport: backpressure, dropping', { event_type: event.type })
      return
    }
    // For critical messages, drop the oldest non-critical message.
    const dropIdx = ctx.sendQueue.findIndex((m) => !CRITICAL_TYPES.has(m.event.type))
    if (dropIdx >= 0) ctx.sendQueue.splice(dropIdx, 1)
  }

  ctx.sendQueue.push({ event, push, pushTitle: pushMeta?.title, pushBody: pushMeta?.body, enqueuedAt: Date.now() })
  drainSendQueue(ctx)
}

/**
 * Drain every queued item, shifting each one after its send attempt regardless
 * of whether live delivery succeeded.
 *
 * The sendQueue is a burst-smoothing buffer, NOT the durability mechanism. Every
 * built frame is recorded into the retransmit buffer inside sendToAll BEFORE
 * delivery, so a frame that fails live delivery is still replayable on an iOS
 * resend request, and iOS resyncs full state from the periodic snapshot on
 * reconnect. Keeping an item in the queue until delivery succeeded (the previous
 * behavior) coupled the queue to connectivity and was the root of a
 * machine-freezing wedge: when the paired peer was asleep, sendToAll returned
 * false, the head never shifted, and every subsequent engine event re-encrypted
 * that same stuck head. Worse, because the live-transcript deltas are all
 * CRITICAL_TYPES, once the queue filled it never dropped them — it grew without
 * bound while enqueueSend ran an O(n) findIndex over it per event, an O(n^2)
 * main-thread spin. Draining unconditionally keeps the queue bounded (≈one item)
 * and delegates durability to the retransmit buffer where it belongs.
 */
export function drainSendQueue(ctx: SendCtx): void {
  while (ctx.sendQueue.length > 0) {
    // Watchdog breadcrumb: a climbing counter under relay_send while the main
    // thread is stalled points the stall diagnostic straight at this loop.
    mark(Activity.RelaySend)
    const item = ctx.sendQueue[0]
    sendToAll(ctx, item.event, item.push, item.pushTitle, item.pushBody, item.enqueuedAt)
    ctx.sendQueue.shift()
  }
}

/** Encrypt and send an event to all paired devices. Returns true if it reached at least one. */
export function sendToAll(
  ctx: SendCtx,
  event: RemoteEvent,
  push: boolean,
  pushTitle?: string,
  pushBody?: string,
  enqueuedAt?: number,
): boolean {
  // Breadcrumb: serialization of an oversized event is one wedge candidate.
  mark(Activity.RelayStringify)
  const plaintext = JSON.stringify(event)
  const eventType = event.type
  // Safety valve: never feed a pathologically large payload into the synchronous
  // compress/encrypt pipeline — that is the relay-wedge failure mode. Drop it
  // with a loud error; iOS heals via the next snapshot resync.
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    log('transport: dropping oversized event before send', { event_type: eventType, chars: plaintext.length, cap: MAX_PLAINTEXT_BYTES })
    return false
  }
  if (event.type === 'desktop_snapshot') {
    // Log snapshot size before compression.
    log('transport: snapshot payload', { bytes: plaintext.length, tab_count: (event as any).tabs?.length ?? 0 })
  }

  // Breadcrumb + compress ONCE: DEFLATE is deterministic, so the compressed
  // bytes are identical for every device — only encryption (per secret) is
  // per-device. Compressing inside the per-device loop multiplied the top wedge
  // candidate by the connected-device count.
  mark(Activity.RelayCompress)
  const wire = compressPayload(plaintext)

  let sentAny = false

  // Send to each device via its preferred transport.
  for (const [deviceId, secret] of ctx.deviceSecrets) {
    // buildDeviceFrame marks its own relay_encrypt sub-stage.
    const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, eventType, ctx.nextSeq, push, pushTitle, pushBody, enqueuedAt, ctx.epoch)
    if (!msg) continue // encrypt failed — skip this device

    // Buffer the built frame for retransmission BEFORE sending, so a frame
    // lost in transit can be replayed on an iOS resend request. We buffer
    // every frame we attempt to send (LAN or relay); a resend re-sends the
    // byte-identical original. Do not buffer resend replays themselves
    // (resend() re-sends from here-stored frames, not via sendToAll).
    mark(Activity.RelayRecord)
    ctx.retransmit.record(deviceId, msg)

    mark(Activity.RelayDeliver)
    if (ctx.deliverFrame(deviceId, msg)) sentAny = true
  }

  return sentAny
}
