import { debug as _debug, error as _error } from '../logger'
import { mark, Activity } from '../watchdog'
import { buildFrameCore } from './transport-frame-pipeline'
import type { WireMessage } from './protocol'

/**
 * Build a per-device wire frame: assign the next seq and encrypt the (already
 * compressed) payload with the device secret, or fall back to the uncompressed
 * plaintext when there is no 32-byte secret. Returns null when encryption fails
 * (the caller skips that device).
 *
 * Compression is done ONCE by the caller and the resulting `wire` buffer is
 * passed in: DEFLATE is deterministic, so the compressed bytes are identical for
 * every device, and compressing per device multiplied the top main-thread wedge
 * candidate by the device count. Only encryption (per-secret) is per-device.
 * `eventType` is passed in for the send-telemetry log line so this function no
 * longer re-parses the plaintext per device.
 *
 * Extracted from RemoteTransport so the per-device build is defined once and
 * shared by the broadcast path (_sendToAll) and the targeted path
 * (sendToDevice), keeping transport.ts within the file-size cap. `nextSeq`
 * is the transport's PER-DEVICE monotonic seq allocator: each paired device
 * has its own counter, so every device receives a contiguous 1,2,3,... stream
 * regardless of how many other devices are paired. (A single shared counter
 * gave each device a strided subsequence, which tripped iOS gap detection on
 * nearly every frame in multi-device setups.)
 *
 * Per-frame send logging: emits one structured log line per outbound frame
 * so the wire-latency Grafana dashboard (docs/observability/grafana/...
 * /reliability/wire-latency.json) can panel on event_type latency. Fields
 * live in the `fields` map so they are additive and do not change any wire
 * message shape. The `queue_dwell_ms` field requires `enqueuedAt` (epoch ms
 * when the event was pushed onto the send queue); omitted when absent.
 */
export function buildDeviceFrame(
  deviceId: string,
  secret: Buffer,
  plaintext: string,
  /** Compressed wire buffer for `plaintext` (compressed once by the caller). */
  wire: Buffer,
  /** RemoteEvent type string, for the per-frame send-telemetry log line. */
  eventType: string,
  nextSeq: (deviceId: string) => number,
  push: boolean,
  pushTitle?: string,
  pushBody?: string,
  /** Optional: epoch ms when the event entered the send queue. Used for queue_dwell_ms. */
  enqueuedAt?: number,
  /** Outbound-seq epoch (generation id) stamped on the frame; see WireMessage.epoch. */
  epoch?: number,
): WireMessage | null {
  const sendTs = Date.now()
  const seq = nextSeq(deviceId)
  // Breadcrumb: AES-256-GCM over the compressed buffer — only when a real key
  // encrypts (the plaintext fallback does no crypto work). The pure build core
  // (shared with the crypto worker) carries no watchdog/logger imports, so the
  // main-thread breadcrumb and the error log live here in the wrapper.
  if (secret.length === 32) mark(Activity.RelayEncrypt)
  const { frame: msg, error } = buildFrameCore(deviceId, secret, plaintext, wire, seq, sendTs, {
    push, pushTitle, pushBody, epoch,
  })
  if (!msg) {
    _error('transport-frame', `encrypt failed for device ${deviceId}: ${error}`)
    return null
  }

  // Per-frame structured send telemetry. The `fields` map is additive — it
  // carries only diagnostics metadata and does not affect wire framing or iOS
  // decoding.
  //
  // Emitted at INFO, not DEBUG. This is telemetry the Ion Wire Latency
  // dashboard panels on (queue_dwell_ms / payload_bytes), and the desktop's
  // only path to Loki is logger.ts → desktop.jsonl → log-egress, which is
  // gated at minLevel=INFO with no production DEBUG override. A DEBUG line is
  // dropped before it is written or shipped, so the desktop-send panels would
  // read empty even while frames are actively sent. INFO is the correct level
  // for a per-frame metric that must survive to the log stream regardless of
  // operational verbosity (mirrors the iOS receive side, whose TRACE frames
  // reach Loki verbatim via the diagnostic-log tailer). One line per outbound
  // frame is bounded by the send rate and acceptable for a transport metric.
  //
  // Fields:
  //   event_type     — RemoteEvent type string (for Grafana panel bucketing)
  //   seq            — frame sequence number
  //   device_id      — recipient device ID (first 8 chars)
  //   send_ts        — epoch ms at frame build time
  //   payload_bytes  — compressed payload size (wire bytes before encrypt)
  //   queue_dwell_ms — ms between enqueue and send (absent when not available)
  //
  // eventType is passed in by the caller (it already has the event) rather than
  // re-parsed from plaintext here — the old JSON.parse ran once per device per
  // frame, an O(payload) cost on the exact hot path a flood hammers.
  const queueDwell = enqueuedAt !== undefined ? sendTs - enqueuedAt : undefined
  _debug('transport-frame', `send seq=${seq} type=${eventType} device=${deviceId.slice(0, 8)} bytes=${wire.length}${queueDwell !== undefined ? ` dwell=${queueDwell}ms` : ''}`, {
    fields: {
      event_type: eventType,
      seq,
      device_id: deviceId,
      send_ts: sendTs,
      payload_bytes: wire.length,
      ...(queueDwell !== undefined ? { queue_dwell_ms: queueDwell } : {}),
    },
  })

  return msg
}
