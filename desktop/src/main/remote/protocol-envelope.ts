/**
 * protocol-envelope — transport envelope, auth handshake, and pairing types
 * for the desktop↔iOS wire, extracted from protocol.ts at the 600-line cap
 * split. protocol.ts re-exports everything here so existing import paths
 * remain valid; the RemoteCommand/RemoteEvent unions stay in protocol.ts.
 */

// ─── Relay control frames (injected by relay, not by Ion) ───

export interface RelayControlMessage {
  type: 'relay:peer-disconnected' | 'relay:peer-reconnected' | 'relay:paired' | 'relay:ping' | 'relay:pong' | 'relay:push-failed'
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

export interface AuthResult {
  type: 'auth_result'
  success: boolean
  reason?: string
}

export type AuthMessage = AuthChallenge | AuthResponse | AuthResult

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
