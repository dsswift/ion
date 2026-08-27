/**
 * protocol-envelope — transport envelope, auth handshake, and pairing types
 * for the desktop↔iOS wire, extracted from protocol.ts at the 600-line cap
 * split. protocol.ts re-exports everything here so existing import paths
 * remain valid; the RemoteCommand/RemoteEvent unions stay in protocol.ts.
 */

// ─── Relay control frames (injected by relay, not by Ion) ───

export interface RelayControlMessage {
  type: 'relay:connected' | 'relay:peer-disconnected' | 'relay:peer-reconnected' | 'relay:paired' | 'relay:ping' | 'relay:pong' | 'relay:push-failed'
  /** Failure reason (queue_full | invalid_token | transient | token | marshal | request | transport). Present when type === 'relay:push-failed'. */
  reason?: string
  /** Resource ID from the originating push message. Present when type === 'relay:push-failed'. */
  resourceId?: string
}

// ─── Wire envelope (wraps RemoteEvent for relay transport) ───

/**
 * Hard cap on the serialized size of one WireMessage — the JSON frame that
 * actually crosses the WebSocket (envelope + base64 ciphertext). Every wire
 * consumer enforces a receive limit, and a frame larger than the tightest one
 * is undeliverable: the receiver fails the read, disconnects, resyncs, and the
 * desktop rebuilds the same oversized frame — a reconnect loop.
 *
 * Receive limits this cap must stay under:
 *   - relay read limit: 12 MB — `relay/relay.go:42` (`MaxMessageSize: 12 *
 *     1024 * 1024`, field documented at relay.go:33), applied via
 *     `conn.SetReadLimit(h.MaxMessageSize)` at relay.go:189.
 *   - iOS `URLSessionWebSocketTask.maximumMessageSize`: 16 MiB —
 *     `ios/IonRemote/Networking/LANClient.swift:108` and
 *     `RelayClient.swift:170`.
 *
 * 8 MiB leaves comfortable headroom under the tightest limit (relay, 12 MB).
 * The desktop's pre-send plaintext gate (MAX_PLAINTEXT_BYTES in
 * transport-send.ts) is sized so a worst-case incompressible payload lands at
 * roughly this cap after DEFLATE + base64; this constant is the authoritative
 * backstop on the frame the wire actually carries.
 */
export const MAX_WIRE_FRAME_BYTES = 8 * 1024 * 1024

export interface WireMessage {
  seq: number
  ts: number               // Unix ms timestamp
  // Outbound-seq epoch (generation id). Stable for the life of one desktop
  // outbound-seq space; regenerated whenever that space resets to seq=1 (desktop
  // process restart → new RemoteTransport, or an in-process stop()). iOS keys its
  // receive-side dedup high-water to this: when the epoch changes it resets
  // lastReceivedSeq/pendingResendSeqs BEFORE the seq comparison, so a fresh seq=1
  // stream after a desktop restart is not mistaken for stale/duplicate frames
  // (the retransmit buffer is also empty post-restart, so resend can't heal it —
  // the epoch is the deterministic signal). Omitted only by a desktop predating
  // the field; iOS treats absent epoch as "unchanged" (legacy behavior).
  epoch?: number
  payload?: string         // JSON-encoded RemoteEvent or RemoteCommand (absent when encrypted)
  push?: boolean           // hint to relay: send APNs push if peer is disconnected
  pushTitle?: string       // notification title (used by relay when push=true)
  pushBody?: string        // notification body (used by relay when push=true)
  pushTabId?: string       // tab ID for deep-link routing (used by relay when push=true)
  nonce?: string           // base64 12-byte nonce (present when encrypted)
  ciphertext?: string      // base64 encrypted payload (replaces `payload` when encrypted)
  deviceId?: string        // identifies the sending device (set by transport)
}

export interface PayloadChunkEnvelope {
  type: 'desktop_payload_chunk'
  transferId: string
  index: number
  count: number
  originalType: string
  totalBytes: number
  sha256: string
  /** Base64-encoded window of the original UTF-8 JSON bytes. */
  data: string
}

// ─── Auth handshake (exchanged before any data flows) ───

export interface AuthChallenge {
  type: 'auth_challenge'
  nonce: string            // base64-encoded 32 random bytes
}

export interface AuthResponse {
  type: 'auth_response'
  deviceId: string         // paired device ID
  proof: string            // HMAC-SHA256(nonce, sharedSecret), base64
}

/**
 * The Desktop knows this device but cannot use its stored pairing secret.
 * iOS starts codeless repair from this frame instead of waiting for close 4004,
 * whose callback can arrive after the auth result has already been classified.
 */
export const LAN_AUTH_REASON_SECRET_UNUSABLE = 'pairing_secret_unusable' as const

export type AuthFailureReasonCode = typeof LAN_AUTH_REASON_SECRET_UNUSABLE

export interface AuthResult {
  type: 'auth_result'
  success: boolean
  reason?: string
  /** Stable client decision code. `reason` remains human-readable detail. */
  reasonCode?: AuthFailureReasonCode
}

export type AuthMessage = AuthChallenge | AuthResponse | AuthResult

// ─── LAN WebSocket close codes ───
//
// Application close codes (4000-4999) are DEFINITIVE identity verdicts: iOS
// classifies any code in this range as `.rejected` rather than `.transient`
// (see LANAuthOutcome.resolve). Protocol codes outside the range (e.g. 1008
// auth cooldown) carry no verdict and are treated as transient. Adding a code
// here is a desktop↔iOS wire change and must ship with its iOS counterpart in
// the same PR (lockstep).

/** iOS-initiated unpair. Sent by the client, not the desktop. */
export const LAN_CLOSE_UNPAIR = 4000

/**
 * The desktop does not recognise this device, or has revoked it. Terminal:
 * the client must pair afresh (with a PIN); there is nothing to recover.
 */
export const LAN_CLOSE_UNKNOWN_DEVICE = 4003

/**
 * The desktop KNOWS this device but cannot use its stored pairing secret —
 * the record decrypted to ciphertext or to a non-32-byte value, typically
 * because the OS keychain grant was lost across a desktop reinstall.
 *
 * Distinct from `LAN_CLOSE_UNKNOWN_DEVICE` because the fault is on the desktop
 * side and is self-repairable: the desktop still holds the device's
 * `mobileDeviceId`, so the client can perform a codeless recovery re-pair over
 * the LAN and restore the connection with no user action. iOS routes this code
 * to that repair rather than to the "pairing rejected" screen.
 */
export const LAN_CLOSE_SECRET_UNUSABLE = 4004

// ─── Paired device record ───

export interface PairedDevice {
  id: string
  name: string
  pairedAt: string
  lastSeen: string | null
  channelId: string
  /** Base64-encoded shared secret (NaCl secretbox key) */
  sharedSecret: string
  /** APNs device token for push notifications */
  apnsToken?: string
  /** Stable hardware UUID from the iOS device (IOPlatformUUID equivalent).
   *  Used for recovery re-pair dedup instead of the mutable deviceName. */
  mobileDeviceId?: string
  /**
   * Per-desktop display override cached on the iOS side. Not authoritative —
   * the desktop owns the value via the top-level `remoteDisplay` settings
   * record. Present here only to mirror the iOS PairedDevice struct.
   * Identifier from the curated icon set: "desktop", "laptop", "macmini",
   * "macpro", "display", "server", "terminal", "briefcase", "house",
   * "gamepad". Unknown values render as the default desktop glyph.
   */
  customName?: string | null
  customIcon?: string | null
  relayOidcAccountUsername?: string
  relayOidcAccountName?: string
  relayOidcSubject?: string
  relayOidcTenantId?: string
  relayOidcSignedInAt?: string
  relayOidcAccessStatus?: string
  relayOidcAccessReason?: string
  relayOidcReportedAt?: string
}

// ─── Transport state ───

export type TransportState = 'disconnected' | 'relay_only' | 'lan_preferred'
