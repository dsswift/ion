/**
 * One-time relay pairing channels (manifest requirement:
 * `auth.createPairingChannel{relayUrl}` -> `{channelId: 'pairing:'+hex,
 * expiresAt}`, announced with `pairing:true`; revoked on
 * `auth.cancelPairingChannel`).
 *
 * A pairing channel is a `RelayClient` connected under a fresh
 * `'pairing:'+hex` channel id, announcing `{pairing:true, expiresAt}` instead
 * of an issuer/audience/scope trust (manifest C7). The relay enforces the
 * channel's single-use and expiry semantics on the MOBILE-JOIN side
 * (`relay/announce.go`'s `validateAgainstAnnouncedTrust`); this module tracks
 * the SAME lifecycle server-side so `auth.listClients`-adjacent tooling and
 * `cancelPairingChannel` have something to act on without round-tripping to
 * the relay, and so the ion-side `RelayClient` is torn down (not left
 * connected) once the channel is no longer usable.
 */
import { randomBytes } from 'crypto'
import { RelayClient } from '../remote/relay-client'
import type { WireMessage } from '../remote/protocol-envelope'
import { isRelayPairRequest, isRelayIdentity, type RelayPairRequest, type RelayPairResponse, type EnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import { completePairing } from './pairing-links'
import { resolvePairingBearer } from './pairing-bearer'
import { currentServerConfig } from '../config/current'
import type { ServerOidcConfig } from '../config/server-config'
import { credentialsStore } from './credentials-store'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-pairing-channels', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-pairing-channels', msg, fields)
}

const CHANNEL_TTL_MS = 5 * 60 * 1000

interface PairingChannelRecord {
  channelId: string
  relayUrl: string
  expiresAt: number
  used: boolean
  client: RelayClient
  expiryTimer: ReturnType<typeof setTimeout>
}

const channels = new Map<string, PairingChannelRecord>()

export interface CreatePairingChannelResult {
  channelId: string
  expiresAt: number
}

export interface CreatePairingChannelOptions {
  /** Test-only override of the 5-minute default TTL. */
  ttlMs?: number
  /** The relays a completed pairing is told about (`auth/relay-advertise.ts#advertisedRelays`). */
  advertisedRelays?: () => EnvironmentRelay[]
  /** The identity provider a request's `bearer` is verified against. Defaults to the live `server.json`. */
  getOidc?: () => ServerOidcConfig | null
}

function closeChannel(channelId: string, reason: string): void {
  const record = channels.get(channelId)
  if (!record) return
  clearTimeout(record.expiryTimer)
  record.client.disconnect()
  channels.delete(channelId)
  log('pairing channel closed', { channel_id: channelId, reason })
}

/** Opens a relay pairing channel and announces it (manifest C7). */
export function createPairingChannel(relayUrl: string, apiKey: string, options: CreatePairingChannelOptions = {}): CreatePairingChannelResult {
  const channelId = `pairing:${randomBytes(16).toString('hex')}`
  const ttlMs = options.ttlMs ?? CHANNEL_TTL_MS
  const expiresAt = Date.now() + ttlMs

  const client = new RelayClient({ relayUrl, apiKey, channelId, announceTrust: { pairing: true, expiresAt } })
  // The joining client sends the same request `POST /auth/pair` takes, as
  // one plaintext message on this single-use channel; the answer is the
  // same completion, plus the relays it can use from now on. One
  // completion function for both doors (auth-pair.ts's own note).
  const getOidc = options.getOidc ?? ((): ServerOidcConfig | null => currentServerConfig().oidc)
  const complete = (message: RelayPairRequest, accompanyingSubject: string | undefined): void => {
    const result = completePairing(credentialsStore(), { code: message.code, peerPublicKey: message.peerPublicKey, label: typeof message.label === 'string' ? message.label : '', kind: message.kind === 'mobile' ? 'mobile' : 'desktop', deviceId: typeof message.deviceId === 'string' ? message.deviceId : undefined, relayIdentity: isRelayIdentity(message.relayIdentity) ? message.relayIdentity : undefined, accompanyingSubject })
    if (!result.ok) {
      log('pairing over relay refused', { channel_id: channelId, reason: result.reason })
      client.send({ type: 'pair_response', ok: false, error: result.reason } as unknown as WireMessage)
      return
    }
    const response: RelayPairResponse = { type: 'pair_response', ok: true, clientId: result.clientId, ourPublicKey: result.ourPublicKey, scopes: result.scopes, relays: options.advertisedRelays?.() ?? [] }
    client.send(response as unknown as WireMessage)
    log('pairing completed over relay', { channel_id: channelId, client_id: result.clientId, relay_url: relayUrl, signed_in: accompanyingSubject !== undefined })
    // Sent, then torn down: the channel's one use is spent.
    setTimeout(() => markPairingChannelUsed(channelId), 250)
  }
  client.on('message', (message: WireMessage) => {
    if (!isRelayPairRequest(message)) {
      warn('pairing channel ignored a non-pair_request message', { channel_id: channelId })
      return
    }
    if (!isPairingChannelActive(channelId)) {
      warn('pair_request on an inactive pairing channel', { channel_id: channelId })
      client.send({ type: 'pair_response', ok: false, error: 'expired' } as unknown as WireMessage)
      return
    }
    const bearer = typeof message.bearer === 'string' ? message.bearer : undefined
    if (!bearer) {
      complete(message, undefined)
      return
    }
    // Checked before the code is spent, exactly as the LAN door does.
    resolvePairingBearer(bearer, getOidc())
      .then((signedIn) => {
        if (!signedIn.ok) {
          log('pairing over relay refused', { channel_id: channelId, reason: signedIn.reason })
          client.send({ type: 'pair_response', ok: false, error: signedIn.reason } as unknown as WireMessage)
          return
        }
        complete(message, signedIn.subject)
      })
      .catch((err: unknown) => {
        warn('pairing over relay failed while verifying its bearer', { channel_id: channelId, error: String(err) })
        client.send({ type: 'pair_response', ok: false, error: 'invalid_bearer' } as unknown as WireMessage)
      })
  })
  client.connect()

  const expiryTimer = setTimeout(() => closeChannel(channelId, 'expired'), ttlMs)
  expiryTimer.unref?.()

  channels.set(channelId, { channelId, relayUrl, expiresAt, used: false, client, expiryTimer })
  log('pairing channel created', { channel_id: channelId, relay_url: relayUrl, expires_at: expiresAt })
  return { channelId, expiresAt }
}

/** Revokes a pairing channel before its natural expiry. Returns false when no such channel exists. */
export function cancelPairingChannel(channelId: string): boolean {
  if (!channels.has(channelId)) {
    warn('cancel refused: unknown pairing channel', { channel_id: channelId })
    return false
  }
  closeChannel(channelId, 'cancelled')
  return true
}

/** Marks a channel's one permitted use consumed, then tears it down (a used channel has nothing left to do). */
export function markPairingChannelUsed(channelId: string): boolean {
  const record = channels.get(channelId)
  if (!record) return false
  record.used = true
  closeChannel(channelId, 'used')
  return true
}

/** True while `channelId` exists, is unused, and has not passed its expiry. */
export function isPairingChannelActive(channelId: string): boolean {
  const record = channels.get(channelId)
  if (!record) return false
  if (record.used) return false
  if (Date.now() > record.expiresAt) return false
  return true
}

/** TEST ONLY. Closes and clears every tracked pairing channel between test cases. */
export function _resetPairingChannelsForTest(): void {
  for (const channelId of [...channels.keys()]) closeChannel(channelId, 'test-reset')
}
