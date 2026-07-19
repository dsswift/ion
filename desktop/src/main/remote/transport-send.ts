// Outbound send-queue path for RemoteTransport, extracted from transport.ts.
//
// This is the hot path: every engine event the desktop forwards to a paired
// iOS device flows through enqueueSend → drainSendQueue → sendToAll. It was
// lifted out of the RemoteTransport class both to keep transport.ts under the
// file-size cap and to make the drain logic unit-testable in isolation (the
// class methods it replaced could only be exercised through a fully wired
// transport). The functions operate on an explicit SendCtx rather than `this`,
// mirroring the transport-lan-auth.ts helper pattern already used here.

import { log as _log, error as _error } from '../logger'
import { buildDeviceFrame } from './transport-frame'
import { compressPayload } from './transport-compression'
import { mark, Activity } from '../watchdog'
import { MAX_WIRE_FRAME_BYTES } from './protocol'
import type { RemoteEvent, WireMessage } from './protocol'
import type { RetransmitBuffer } from './retransmit-buffer'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

/** Cap on queued-but-undelivered events before backpressure kicks in. */
export const MAX_QUEUE_SIZE = 500

/**
 * Early gate on the serialized size of a single event's PLAINTEXT, checked
 * before the synchronous stringify→compress→encrypt pipeline. It serves two
 * purposes:
 *
 *  1. Wedge guard (the original rationale): a pathological payload would
 *     otherwise DEFLATE-and-encrypt for many seconds on the main thread (a
 *     relay wedge). Dropping it here keeps the hot path bounded.
 *  2. Frame-cap pre-filter: the wire frame is capped at MAX_WIRE_FRAME_BYTES
 *     (8 MiB — see protocol.ts, sized under the relay's 12 MB read limit and
 *     iOS's 16 MiB maximumMessageSize). A worst-case incompressible 6 MB
 *     plaintext inflates to ≈8 MB after DEFLATE (no gain) + base64 (×4/3),
 *     i.e. right at the frame cap — so anything that passes this gate cannot
 *     meaningfully exceed the frame gate in sendToAll, and anything larger is
 *     dropped before burning compress/encrypt time on an undeliverable frame.
 *
 * When it trips, the event is dropped with an error log; iOS recovers state
 * via its periodic snapshot resync. Measured on `String.length` (UTF-16 code
 * units), which is O(1) and close enough to bytes for a ceiling this coarse.
 */
export const MAX_PLAINTEXT_BYTES = 6 * 1024 * 1024

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

// ─── Two-lane send prioritization ────────────────────────────────────────────
//
// The send queue is split into two logical lanes to prevent head-of-line
// blocking: a 60 KB desktop_snapshot must not delay a 40-byte
// desktop_text_delta enqueued behind it. FIFO order IS load-bearing *within*
// interactive traffic (desktop_stream_reset must ride FIFO with
// desktop_text_delta — see CRITICAL_TYPES), so ordering is preserved within
// each lane; only the interleave *between* lanes is reprioritized.
//
// Cross-lane reorder safety: delivering a delta ahead of the snapshot that was
// enqueued before it is safe because snapshot-vs-delta consistency is
// reconciled by the iOS fingerprint heal (periodic snapshot resync), not by
// seq adjacency. A snapshot is a wholesale state replace; a delta applied
// "early" relative to it is absorbed by the next reconcile.
//
// Seq monotonicity invariant: the wire seq is allocated inside sendToAll at
// frame-build time (ctx.nextSeq, called by buildDeviceFrame) DURING the drain,
// not at enqueue time. So build order == delivery order == monotonic seq per
// device, regardless of how the lanes interleave. Lane selection can never
// produce an out-of-order seq on the wire.

/** Send lane: bulk (large reconcile payloads) vs interactive (everything else). */
export type Lane = 'bulk' | 'interactive'

/** Starvation guard: a bulk item older than this is picked ahead of interactive. */
export const BULK_STARVATION_MS = 2000

/**
 * Event types routed to the bulk lane: large, snapshot/reconcile-semantics
 * payloads whose delivery can safely trail live interactive traffic. Everything
 * else (text deltas, status, tool events, permission requests, ...) is
 * interactive. Several of these currently ship via the direct sendToDevice
 * path (no queue), but the classifier keys on payload nature so any future
 * queued send lands in the right lane.
 */
const BULK_TYPES = new Set([
  'desktop_snapshot',
  'desktop_terminal_snapshot',
  'desktop_conversation_history',
  'desktop_agent_conversation_history',
  'desktop_settings_snapshot',
  'desktop_plan_content',
  'desktop_resource_content',
  'desktop_fs_file_content',
  'desktop_fs_image_content',
])

/** Classify an outbound event type into its send lane. */
export function laneForEventType(type: string): Lane {
  return BULK_TYPES.has(type) ? 'bulk' : 'interactive'
}

/** One queued outbound event plus its push metadata, lane, and enqueue timestamp. */
export interface SendQueueItem {
  event: RemoteEvent
  push: boolean
  pushTitle?: string
  pushBody?: string
  enqueuedAt: number
  lane: Lane
}

/**
 * The transport state the send path touches. Passed explicitly so the functions
 * are pure with respect to the transport instance and can be unit tested with a
 * hand-built context.
 *   - sendQueue: mutated in place (push / splice); never reassigned. Holds both
 *     lanes in one push-ordered array (see nextSendIndex).
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
  // If the queue is full, apply backpressure. The cap and the eviction scan
  // both span the single array, i.e. BOTH lanes combined: MAX_QUEUE_SIZE
  // counts bulk + interactive together, and the oldest non-critical item is
  // evicted regardless of its lane (push order == age order across lanes).
  if (ctx.sendQueue.length >= MAX_QUEUE_SIZE) {
    if (!CRITICAL_TYPES.has(event.type)) {
      log('transport: backpressure, dropping', { event_type: event.type })
      return
    }
    // For critical messages, drop the oldest non-critical message.
    const dropIdx = ctx.sendQueue.findIndex((m) => !CRITICAL_TYPES.has(m.event.type))
    if (dropIdx >= 0) ctx.sendQueue.splice(dropIdx, 1)
  }

  ctx.sendQueue.push({ event, push, pushTitle: pushMeta?.title, pushBody: pushMeta?.body, enqueuedAt: Date.now(), lane: laneForEventType(event.type) })
  drainSendQueue(ctx)
}

/**
 * Pick the index of the next item to send under the two-lane policy:
 *
 *  1. Starvation guard first: the oldest bulk item that has waited longer than
 *     BULK_STARVATION_MS goes ahead of interactive traffic, so a sustained
 *     interactive stream (e.g. a long text-delta burst) cannot starve a
 *     snapshot indefinitely.
 *  2. Otherwise the first interactive item (FIFO within the lane — the array
 *     is push-ordered, so the first match is the oldest).
 *  3. Otherwise the first bulk item (interactive lane is empty).
 *
 * Single-array structure: both lanes live in the one push-ordered sendQueue
 * (transport.ts holds a stable reference to it and it must never be
 * reassigned), so lane FIFO falls out of scan order and cross-lane backpressure
 * (MAX_QUEUE_SIZE, oldest-non-critical eviction) needs no lane bookkeeping.
 * Exported for direct unit testing of the selection policy.
 */
export function nextSendIndex(queue: SendQueueItem[], now: number): number {
  if (queue.length === 0) return -1
  // Push order is time order, so the first item of a lane is its oldest.
  const bulkIdx = queue.findIndex((q) => q.lane === 'bulk')
  const interactiveIdx = queue.findIndex((q) => q.lane === 'interactive')
  // Starvation guard: an over-age bulk item beats interactive traffic.
  if (bulkIdx >= 0 && now - queue[bulkIdx].enqueuedAt >= BULK_STARVATION_MS) return bulkIdx
  if (interactiveIdx >= 0) return interactiveIdx
  return bulkIdx
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
 *
 * Items are picked lane-aware (see nextSendIndex): interactive first, bulk when
 * interactive is empty, over-age bulk (BULK_STARVATION_MS) ahead of everything.
 * FIFO holds within each lane. Seq is allocated at frame-build time here in the
 * drain, so the pick order IS the wire seq order (see the lane comment above).
 */
export function drainSendQueue(ctx: SendCtx): void {
  while (ctx.sendQueue.length > 0) {
    // Watchdog breadcrumb: a climbing counter under relay_send while the main
    // thread is stalled points the stall diagnostic straight at this loop.
    mark(Activity.RelaySend)
    const idx = nextSendIndex(ctx.sendQueue, Date.now())
    const item = ctx.sendQueue[idx]
    sendToAll(ctx, item.event, item.push, item.pushTitle, item.pushBody, item.enqueuedAt)
    ctx.sendQueue.splice(idx, 1)
  }
}

/** Encrypt and send an event to all paired devices. Returns true if it reached at least one. */
/**
 * Authoritative wire-frame size gate, shared by every path that builds a
 * frame (broadcast sendToAll here and the direct sendToDevice path in
 * transport.ts). Returns false — after logging an ERROR — when the serialized
 * frame exceeds MAX_WIRE_FRAME_BYTES and must be dropped before it is
 * recorded for retransmit or delivered. See the call-site comment in
 * sendToAll for the full rationale (receiver read limits, reconnect loop).
 */
export function frameWithinWireCap(msg: WireMessage, eventType: string, deviceId: string): boolean {
  const frameChars = JSON.stringify(msg).length
  if (frameChars > MAX_WIRE_FRAME_BYTES) {
    _error('RemoteTransport', 'transport: dropping oversized wire frame', { event_type: eventType, device_id: deviceId, frame_chars: frameChars, cap: MAX_WIRE_FRAME_BYTES, note: 'iOS heals via snapshot resync' })
    return false
  }
  return true
}

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
  // Early gate: never feed a pathologically large payload into the synchronous
  // compress/encrypt pipeline (the relay-wedge failure mode), and pre-filter
  // for the wire-frame cap below (see MAX_PLAINTEXT_BYTES doc). Drop it with a
  // loud log; iOS heals via the next snapshot resync.
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

    // Authoritative frame-size backstop, on the SERIALIZED frame — the JSON
    // that actually crosses the WebSocket (envelope + base64 ciphertext).
    // The plaintext gate above is only a pre-filter: DEFLATE + base64 can
    // inflate a poorly-compressible payload past what the receivers accept
    // (relay SetReadLimit 12 MB, iOS maximumMessageSize 16 MiB — see
    // MAX_WIRE_FRAME_BYTES in protocol.ts). An oversized frame is
    // undeliverable: the receiver fails the read, disconnects, resyncs, and
    // the desktop rebuilds the same frame — a reconnect loop.
    //
    // Measured with one exact JSON.stringify. The delivery path (lan-server /
    // relay-client) stringifies again internally, but that seam is per
    // transport behind _deliverFrame and cannot reuse this string without
    // widening transport.ts; one extra stringify of an already-built frame is
    // cheap and exact, and this check replaces the old 32 MB cap's
    // wedge-guard role with a real deliverability guarantee.
    //
    // The frame is dropped BEFORE retransmit.record: a frame that can never
    // be delivered must not be replayable — a resend would fail the receiver
    // read identically. iOS heals via the next snapshot resync.
    if (!frameWithinWireCap(msg, eventType, deviceId)) continue

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
