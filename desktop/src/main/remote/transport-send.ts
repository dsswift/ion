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
import { buildFramesForEvent } from './transport-frame-pipeline'
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
//
// This invariant now holds GLOBALLY, not just for broadcasts. Device-targeted
// sends (sendToDevice) route through this same drain via enqueueSendToDevice
// whenever the crypto worker is live, so a targeted frame allocates its seq in
// drain order alongside broadcast frames and delivers in the worker's FIFO
// reply order. Previously sendToDevice took the synchronous sendDirect path,
// which allocated from the same per-device counter but delivered IMMEDIATELY —
// so a targeted frame enqueued while a worker job was in flight got the higher
// seq yet hit the socket first, producing an out-of-order seq on the wire (iOS
// then saw a forward gap and requested a resend). Only the sync-only fallback
// (no live worker) still uses sendDirect, where synchronous delivery already
// equals allocation order because there is no async worker to race.

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
  /**
   * When set, this item is a device-TARGETED send (sendToDevice) — sendToAll
   * builds/delivers it only for this device, not every paired device. Undefined
   * for broadcasts. Routing a targeted send through the queue (instead of the
   * synchronous sendDirect path) keeps its wire seq in drain order relative to
   * in-flight broadcast frames to the same device — see the seq-monotonicity
   * invariant note above.
   */
  targetDeviceId?: string
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
  /**
   * Optional crypto-worker host (transport-send-worker-host.ts). When present
   * and live, sendToAll offloads DEFLATE + AES-GCM to the worker thread; seqs
   * are still allocated here in drain order (the ordering anchor), and the
   * host applies cap gate → retransmit.record → deliverFrame on reply. When
   * absent or dead, the synchronous pipeline below runs unchanged.
   */
  cryptoHost?: {
    usingWorker: boolean
    submit: (plaintext: string, eventType: string, devices: { deviceId: string; seq: number }[], opts: { push: boolean; pushTitle?: string; pushBody?: string; epoch?: number }, enqueuedAt?: number) => boolean
  }
}

/**
 * Apply backpressure before enqueueing `eventType`. Shared by enqueueSend
 * (broadcast) and enqueueSendToDevice (targeted) so both honor the same cap and
 * critical-type protection. Returns false when the item must be dropped (queue
 * full and the event is non-critical); true when it is safe to push (having, if
 * necessary, evicted the oldest non-critical item to make room for a critical
 * one). The cap and eviction scan both span the single array, i.e. BOTH lanes
 * combined and BOTH broadcast + targeted items together: MAX_QUEUE_SIZE counts
 * everything, and the oldest non-critical item is evicted regardless of lane or
 * target (push order == age order).
 */
function applyBackpressure(ctx: SendCtx, eventType: string): boolean {
  if (ctx.sendQueue.length >= MAX_QUEUE_SIZE) {
    if (!CRITICAL_TYPES.has(eventType)) {
      log('transport: backpressure, dropping', { event_type: eventType })
      return false
    }
    // For critical messages, drop the oldest non-critical message.
    const dropIdx = ctx.sendQueue.findIndex((m) => !CRITICAL_TYPES.has(m.event.type))
    if (dropIdx >= 0) ctx.sendQueue.splice(dropIdx, 1)
  }
  return true
}

/** Enqueue an event for delivery, applying backpressure, then drain. */
export function enqueueSend(
  ctx: SendCtx,
  event: RemoteEvent,
  push: boolean,
  pushMeta?: { title?: string; body?: string },
): void {
  if (!applyBackpressure(ctx, event.type)) return
  ctx.sendQueue.push({ event, push, pushTitle: pushMeta?.title, pushBody: pushMeta?.body, enqueuedAt: Date.now(), lane: laneForEventType(event.type) })
  drainSendQueue(ctx)
}

/**
 * Enqueue a device-TARGETED event (the queued replacement for the synchronous
 * sendDirect path) and drain. Identical backpressure and lane classification to
 * enqueueSend; the only difference is the item carries `targetDeviceId`, so the
 * drain builds and delivers it for that one device instead of broadcasting. Used
 * by RemoteTransport.sendToDevice whenever the crypto worker is live, so a
 * targeted frame's wire seq is allocated in drain order alongside in-flight
 * broadcast frames to the same device (no synchronous frame can jump the counter
 * and reach the socket ahead of an earlier-seq worker frame). See the
 * seq-monotonicity invariant note above.
 */
export function enqueueSendToDevice(
  ctx: SendCtx,
  deviceId: string,
  event: RemoteEvent,
  push: boolean,
  pushMeta?: { title?: string; body?: string },
): void {
  if (!applyBackpressure(ctx, event.type)) return
  ctx.sendQueue.push({ event, push, pushTitle: pushMeta?.title, pushBody: pushMeta?.body, enqueuedAt: Date.now(), lane: laneForEventType(event.type), targetDeviceId: deviceId })
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
    sendToAll(ctx, item.event, item.push, item.pushTitle, item.pushBody, item.enqueuedAt, item.targetDeviceId)
    ctx.sendQueue.splice(idx, 1)
  }
}

/** Encrypt and send an event to all paired devices. Returns true if it reached at least one. */
/**
 * Authoritative wire-frame size gate, shared by every path that builds a
 * frame (broadcast sendToAll here, the direct sendToDevice path in
 * transport.ts, and the crypto-worker host, which measures the serialized
 * length on the worker). Returns false — after logging an ERROR — when the
 * serialized frame exceeds MAX_WIRE_FRAME_BYTES and must be dropped before it
 * is recorded for retransmit or delivered. See the call-site comment in
 * sendToAll for the full rationale (receiver read limits, reconnect loop).
 */
export function frameLengthWithinWireCap(frameChars: number, eventType: string, deviceId: string): boolean {
  if (frameChars > MAX_WIRE_FRAME_BYTES) {
    _error('RemoteTransport', 'transport: dropping oversized wire frame', { event_type: eventType, device_id: deviceId, frame_chars: frameChars, cap: MAX_WIRE_FRAME_BYTES, note: 'iOS heals via snapshot resync' })
    return false
  }
  return true
}

/** Convenience wrapper measuring the frame itself (direct sendToDevice path). */
export function frameWithinWireCap(msg: WireMessage, eventType: string, deviceId: string): boolean {
  return frameLengthWithinWireCap(JSON.stringify(msg).length, eventType, deviceId)
}

/**
 * Direct single-device send (the sync-only fallback for transport.ts
 * sendToDevice). No queue, no worker. RemoteTransport.sendToDevice uses this
 * ONLY when the crypto worker is not live (startup failure / permanent
 * degrade); when the worker is live it routes targeted sends through the queued
 * drain via enqueueSendToDevice instead, so their wire seq stays ordered
 * relative to in-flight broadcast frames (see the seq-monotonicity invariant
 * note above). In sync-only mode there is no async worker to race, so
 * synchronous delivery here already equals allocation order.
 *
 * Applies the same two gates as the broadcast path: plaintext early gate, then
 * the authoritative wire-frame cap BEFORE retransmit.record (an undeliverable
 * frame must never be replayable). enqueuedAt = sendTs, so queue dwell reads 0
 * for direct sends.
 */
export function sendDirect(
  deviceId: string,
  secret: Buffer,
  event: RemoteEvent,
  push: boolean,
  nextSeq: (deviceId: string) => number,
  epoch: number | undefined,
  retransmit: RetransmitBuffer,
  deliverFrame: (deviceId: string, frame: WireMessage) => boolean,
): void {
  const plaintext = JSON.stringify(event)
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    log('transport: dropping oversized event before sendToDevice', { event_type: event.type, chars: plaintext.length, cap: MAX_PLAINTEXT_BYTES })
    return
  }
  mark(Activity.RelayCompress)
  const wire = compressPayload(plaintext)
  const msg = buildDeviceFrame(deviceId, secret, plaintext, wire, event.type, nextSeq, push, undefined, undefined, Date.now(), epoch)
  if (!msg) return
  if (!frameWithinWireCap(msg, event.type, deviceId)) return
  retransmit.record(deviceId, msg)
  deliverFrame(deviceId, msg)
}

export function sendToAll(
  ctx: SendCtx,
  event: RemoteEvent,
  push: boolean,
  pushTitle?: string,
  pushBody?: string,
  enqueuedAt?: number,
  targetDeviceId?: string,
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

  // Recipient set: a targeted send (targetDeviceId set — the queued sendToDevice
  // path) goes to exactly that one paired device; a broadcast goes to every
  // paired device. A targeted device that is no longer paired yields an empty
  // set (nothing to build/deliver — the caller's early secret lookup normally
  // catches this, but a device removed between enqueue and drain lands here).
  const recipientIds = targetDeviceId !== undefined
    ? (ctx.deviceSecrets.has(targetDeviceId) ? [targetDeviceId] : [])
    : [...ctx.deviceSecrets.keys()]

  // Breadcrumb + compress ONCE: DEFLATE is deterministic, so the compressed
  // bytes are identical for every device — only encryption (per secret) is
  // per-device. Compressing inside the per-device loop multiplied the top wedge
  // candidate by the connected-device count.

  // Worker offload: when a live crypto worker is attached, allocate every
  // recipient's seq NOW (in drain order — the seq-ordering anchor) and hand the
  // compress+encrypt to the worker thread. The host finishes each frame on
  // reply (cap gate → retransmit.record → deliverFrame) in FIFO reply order,
  // so the wire stream is identical to the synchronous path. Returns true
  // optimistically: delivery outcome is not knowable synchronously here, and
  // the caller (drainSendQueue) does not use the return value — durability is
  // the retransmit buffer either way.
  if (ctx.cryptoHost?.usingWorker) {
    const devices = recipientIds.map((deviceId) => ({ deviceId, seq: ctx.nextSeq(deviceId) }))
    if (devices.length === 0) return false
    const submitted = ctx.cryptoHost.submit(plaintext, eventType, devices, { push, pushTitle, pushBody, epoch: ctx.epoch }, enqueuedAt)
    if (submitted) return true
    // Worker died between the check and the post: fall through to the sync
    // path — but the seqs above are already allocated. Build with THOSE seqs
    // via the pure pipeline so the wire stream stays contiguous.
    mark(Activity.RelayCompress)
    const { results } = buildFramesForEvent(plaintext, devices, ctx.deviceSecrets, { push, pushTitle, pushBody, epoch: ctx.epoch })
    let sent = false
    for (const r of results) {
      if (!r.frame) continue
      if (!frameLengthWithinWireCap(r.serializedLength, eventType, r.deviceId)) continue
      mark(Activity.RelayRecord)
      ctx.retransmit.record(r.deviceId, r.frame)
      mark(Activity.RelayDeliver)
      if (ctx.deliverFrame(r.deviceId, r.frame)) sent = true
    }
    return sent
  }

  mark(Activity.RelayCompress)
  const wire = compressPayload(plaintext)

  let sentAny = false

  // Send to each recipient via its preferred transport.
  for (const deviceId of recipientIds) {
    const secret = ctx.deviceSecrets.get(deviceId)
    if (!secret) continue
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
