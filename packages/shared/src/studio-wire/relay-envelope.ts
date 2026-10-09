/**
 * The E2E envelope every Studio wire frame rides in when it crosses a relay
 * (spec 12, ADR-033 relay-backed environments). The relay forwards opaque
 * text between the two roles of a channel; it never holds a key, so a frame
 * is AES-256-GCM sealed with the pairing's shared secret before it leaves
 * either end and opened after it arrives. Text frames and binary frames
 * (terminal data, file chunks) take the same envelope; `bin` says which.
 *
 * Shared by the desktop's relay transport and the server's relay listener
 * so both ends agree on one shape and one test pins it.
 */
import { encrypt, decrypt } from '../e2e'
import { parseTraceparent } from '../trace-context'

/**
 * What a relay needs to ring a phone that is not connected. These ride the
 * envelope in plaintext, beside the sealed frame, because the relay holds no
 * key: it reads them only when the channel's other role is absent, and sends
 * a push notification instead of forwarding. They are a doorbell, never
 * content -- a title, a short body, and ids to open the right place.
 *
 * `pushToken` and `pushEnv` are the phone's push address. The server owns
 * them (the device registered them with it) and sends them with every push;
 * the relay only delivers, and keeps no address book of its own.
 */
export interface RelayPushMeta {
  pushTitle?: string
  pushBody?: string
  pushTabId?: string
  notifyKind?: string
  notifyResourceId?: string
  /** The phone's APNs device token. */
  pushToken?: string
  /** The APNs environment that issued `pushToken`: `sandbox` or `production`. */
  pushEnv?: string
}

/** The sealed envelope format both ends of a relay channel must share. */
export const RELAY_ENVELOPE_VERSION = 1 as const

export interface RelayEnvelope extends RelayPushMeta {
  v: typeof RELAY_ENVELOPE_VERSION
  nonce: string
  ciphertext: string
  /** Present and true when the sealed bytes are a binary wire frame rather than a JSON text frame. */
  bin?: true
  /** Present and true when the relay should push if it cannot forward. */
  push?: true
  /**
   * A W3C traceparent the sender sets beside the sealed frame, in plaintext.
   * A client sets it on every frame carrying an action (its own span); the
   * server sets it on every frame it sends (the span or engine event the
   * frame belongs to). A relay with tracing on records its `relay.forward`
   * span as a child and rewrites this value with that span's id, so the
   * receiver parents under the relay. It names a span, never content; the
   * receiver opens the sealed frame the same way with or without it.
   */
  traceparent?: string
}

export function isRelayEnvelope(v: unknown): v is RelayEnvelope {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<RelayEnvelope>
  return e.v === 1 && typeof e.nonce === 'string' && typeof e.ciphertext === 'string' && (e.bin === undefined || e.bin === true)
}

/**
 * Seals one wire frame (text or binary) into an envelope string for the relay.
 * `push`, when given, marks the envelope as a doorbell and copies its fields
 * in plaintext; empty fields are left off so the relay's defaults apply.
 */
export function sealRelayFrame(payload: string | Uint8Array, sharedSecret: Buffer, push?: RelayPushMeta, traceparent?: string): string {
  const isBinary = typeof payload !== 'string'
  const { nonce, ciphertext } = encrypt(isBinary ? Buffer.from(payload) : payload, sharedSecret)
  const envelope: RelayEnvelope = isBinary ? { v: RELAY_ENVELOPE_VERSION, nonce, ciphertext, bin: true } : { v: RELAY_ENVELOPE_VERSION, nonce, ciphertext }
  if (push) {
    envelope.push = true
    for (const key of ['pushTitle', 'pushBody', 'pushTabId', 'notifyKind', 'notifyResourceId', 'pushToken', 'pushEnv'] as const) {
      const value = push[key]
      if (typeof value === 'string' && value !== '') envelope[key] = value
    }
  }
  if (traceparent) envelope.traceparent = traceparent
  return JSON.stringify(envelope)
}

/** An opened envelope: the frame, and the plaintext `traceparent` beside it when the sender set a valid one. */
export type OpenedRelayFrame = { bytes: Buffer; isBinary: boolean; traceparent?: string }

/**
 * Opens an envelope. Returns null when the text is not an envelope or does
 * not decrypt: the relay is untrusted transport, so a frame that fails here
 * is dropped by the caller, never acted on. The envelope's `traceparent` is
 * returned only when it parses as one: it is plaintext anyone on the path
 * could write, and it only ever names a span.
 */
export function openRelayFrame(raw: string, sharedSecret: Buffer): OpenedRelayFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRelayEnvelope(parsed)) return null
  const bytes = decrypt(parsed.nonce, parsed.ciphertext, sharedSecret)
  if (bytes === null) return null
  const opened: OpenedRelayFrame = { bytes, isBinary: parsed.bin === true }
  if (parseTraceparent(parsed.traceparent)) opened.traceparent = parsed.traceparent
  return opened
}

/**
 * Pairing over a relay channel: the same exchange `POST /auth/pair` runs,
 * carried as two plaintext JSON messages on a one-time `pairing:<hex>`
 * channel. Plaintext is correct here -- the exchange IS the key agreement,
 * and the channel is single-use and five minutes old at most.
 */
export interface RelayPairRequest {
  type: 'pair_request'
  code: string
  peerPublicKey: string
  label: string
  kind: 'desktop' | 'mobile'
  /** A stable id for the pairing device, so a re-pair replaces its earlier record instead of adding another. */
  deviceId?: string
  /** Who the pairing device is signed in as, when it is. See `RelayIdentity`. */
  relayIdentity?: RelayIdentity
  /**
   * A token from the server's own identity provider, when the device is
   * signed in to it. The relay-channel counterpart of `POST /auth/pair`'s
   * `Authorization` header: the device pairs as the person it names, and a
   * token that does not verify refuses the pairing.
   */
  bearer?: string
}

/**
 * The identity a device presents to an OIDC relay: the issuer that signed it
 * and its subject there. A host whose relay authenticates with OIDC announces
 * this on the device's channel, so the relay admits that one subject even
 * when the host itself is signed in to a different tenant.
 */
export interface RelayIdentity {
  issuer: string
  subject: string
}

export function isRelayIdentity(v: unknown): v is RelayIdentity {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<RelayIdentity>
  return typeof r.issuer === 'string' && !!r.issuer && typeof r.subject === 'string' && !!r.subject
}

export interface RelayPairResponse {
  type: 'pair_response'
  ok: boolean
  clientId?: string
  ourPublicKey?: string
  scopes?: string[]
  /** The relays this server can be reached through afterward (see `EnvironmentRelay`). */
  relays?: EnvironmentRelay[]
  error?: string
}

/**
 * How a client authenticates to one relay a server is reachable through.
 * Handed to a client at pairing time (LAN, SSH, or relay) so a later
 * connect can fall back to the relay without the key ever appearing in a
 * link or a settings screen.
 */
export type EnvironmentRelayAuth =
  | { mode: 'psk'; key: string }
  | { mode: 'oidc'; issuer: string; audience: string; scope: string }
  /**
   * The relay authenticates with its own OIDC issuers. The joining device
   * reads them from the relay (`GET /v1/auth/config`) and presents a token
   * for the entry whose issuer is `issuer`.
   *
   * `issuer` is the tenant this server joins the relay with. The relay binds
   * a channel to the first account on it, so a client must present the same
   * person from the same tenant; a token from any other tenant is refused,
   * or worse, claims the channel first. Absent when the server has not
   * joined the relay yet, and from a server older than the field.
   *
   * `clientId` is the app registration this server signs in with in that
   * tenant. A client signs in as that app to get its relay token. The
   * relay's entry names only the relay's own app (`audience`), which is the
   * API the token is for and often accepts no sign-in of its own. Absent
   * with `issuer`, and when this server has no sign-in app configured.
   */
  | { mode: 'relay-oidc'; issuer?: string; clientId?: string }

export interface EnvironmentRelay {
  url: string
  auth: EnvironmentRelayAuth
}

export function isRelayPairRequest(v: unknown): v is RelayPairRequest {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<RelayPairRequest>
  return m.type === 'pair_request' && typeof m.code === 'string' && typeof m.peerPublicKey === 'string'
}

export function isRelayPairResponse(v: unknown): v is RelayPairResponse {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<RelayPairResponse>
  return m.type === 'pair_response' && typeof m.ok === 'boolean'
}

export function isEnvironmentRelay(v: unknown): v is EnvironmentRelay {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<EnvironmentRelay>
  if (typeof r.url !== 'string' || !r.url || !r.auth || typeof r.auth !== 'object') return false
  const a = r.auth as Partial<EnvironmentRelayAuth>
  if (a.mode === 'psk') return typeof (a as { key?: unknown }).key === 'string'
  if (a.mode === 'relay-oidc') {
    const { issuer, clientId } = a as { issuer?: unknown; clientId?: unknown }
    return (issuer === undefined || typeof issuer === 'string') && (clientId === undefined || typeof clientId === 'string')
  }
  if (a.mode === 'oidc') {
    const o = a as { issuer?: unknown; audience?: unknown; scope?: unknown }
    return typeof o.issuer === 'string' && typeof o.audience === 'string' && typeof o.scope === 'string'
  }
  return false
}
