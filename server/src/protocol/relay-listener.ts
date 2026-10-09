/**
 * relay-listener -- Studio connections that arrive through a relay.
 *
 * For every relay in `server.json.relays[]` (or the desktop's own relay
 * settings, see `auth/relay-advertise.ts`) and every paired client in
 * `credentials.json`, desktop or phone, this holds one `RelayClient` on the channel
 * `deriveChannelId(secret)` in the `ion` role. The relay only ever forwards
 * ciphertext: each channel is wrapped in a `RelayConnectionSocket` that
 * opens inbound envelopes with that client's pairing secret and seals
 * outbound frames the same way, then hands the plaintext to the ordinary
 * admission path (`listener.ts#attachConnection`) as transport `relay`.
 *
 * The pairing secret is the identity. `Connection.preVerifiedClientId` is
 * set to the client the channel belongs to, and `hello.ts` admits that
 * client's `paired` credential without the nonce HMAC a TCP client needs.
 *
 * A pairing can have several clients on its channel at once (a desktop's
 * Studio window and its `ion fleet`, a phone's live session and an admin
 * session). The channel joins as multi-client; a relay that supports it
 * names each client, and each gets its own `RelayConnectionSocket` and
 * `Connection`. A relay that does not keeps one client, as before.
 *
 * Channels open at boot and again after every pairing completes
 * (`refreshRelayStudioClients()`), and close when a client is revoked.
 */
import { deriveChannelId } from '@ion/shared/e2e'
import { encodeFrame } from '@ion/shared/studio-wire/codec'
import { PUSH_DOORBELL_CHANNEL } from '@ion/shared/studio-wire/channels'
import { sealRelayFrame } from '@ion/shared/studio-wire/relay-envelope'
import { SealedSocket, relayCarrier } from './sealed-socket'
import { attachConnection, type ResolvedStudioListenerOptions } from './listener'
import { RelayClient } from '../remote/relay-client'
import type { RelayControlMessage, WireMessage } from '../remote/protocol'
import { connectionRegistry } from './connection'
import { setPushRinger, type PushRinger } from '../thin-view/push-doorbell'
import { credentialsStore, type CredentialClientRecord } from '../auth/credentials-store'
import { relayOidcJoin, announceForDevice, type RelayOidcJoin, type RelayOidcJoinDeps } from '../remote/relay-oidc-join'
import type { ServerRelayConfig } from '../config/server-config'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import { tabIdVisibleToSubject } from './tabs-index'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay-listener', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('relay-listener', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('relay-listener', msg, fields)
}

/**
 * One relay channel presented as the socket `Connection` expects: a
 * `SealedSocket` over the relay carrier. Kept as a named class because it is
 * what this listener constructs per channel connect; the sealing itself is
 * `sealed-socket.ts`, shared with the TCP listener.
 */
export class RelayConnectionSocket extends SealedSocket {
  constructor(relay: RelayClient, sharedSecret: Buffer, clientId: string, peer?: string) {
    super(relayCarrier(relay, peer), sharedSecret, clientId)
  }
}

/**
 * The key of the one connection a channel holds when its relay keeps a
 * single client per pairing. A multi-client relay names each client, and the
 * channel then holds one connection per name.
 */
const SOLE_PEER = ''

interface RelayChannelEntry {
  key: string
  relayUrl: string
  clientId: string
  /** The pairing secret the channel is sealed with; also seals a push doorbell sent outside any connection. */
  secret: Buffer
  client: RelayClient
  /** One connection per client on the channel, keyed by the relay's id for it (`SOLE_PEER` on a relay that keeps one client). */
  sockets: Map<string, RelayConnectionSocket>
}

export interface RelayStudioListenerOptions {
  relays: ServerRelayConfig[]
  listener: ResolvedStudioListenerOptions
  /** How this server reads an OIDC relay's issuers and mints a token for its own. Needed only when a relay is `oidc`. */
  oidc?: RelayOidcJoinDeps
}

/** How long to wait before asking an unreachable OIDC relay for its auth configuration again. */
const OIDC_PROBE_RETRY_MS = 30_000

export interface RelayStudioListenersHandle {
  /** Re-reads the paired clients and opens a channel for any new one. Called after every pairing completes. */
  refresh(): void
  channelCount(): number
  close(): void
}

let active: RelayStudioListenersHandle | null = null

function entryKey(relayUrl: string, clientId: string): string {
  return `${relayUrl}\u0000${clientId}`
}

/**
 * Starts the relay-fed listeners. One process holds one instance; the
 * pairing paths reach it through `refreshRelayStudioClients()`.
 */
export function startRelayStudioListeners(options: RelayStudioListenerOptions): RelayStudioListenersHandle {
  const entries = new Map<string, RelayChannelEntry>()

  // One join per OIDC relay: every channel on it shares one credential stream.
  const joins = new Map<string, RelayOidcJoin>()
  const joinFor = (relayUrl: string, deps: RelayOidcJoinDeps): RelayOidcJoin => {
    let join = joins.get(relayUrl)
    if (!join) {
      join = relayOidcJoin(relayUrl, deps)
      joins.set(relayUrl, join)
    }
    return join
  }
  const opening = new Set<string>()
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const start = (key: string, relay: ServerRelayConfig, record: CredentialClientRecord, secret: Buffer, client: RelayClient): void => {
    const entry: RelayChannelEntry = { key, relayUrl: relay.url, clientId: record.clientId, secret, client, sockets: new Map() }
    // A Connection lasts exactly as long as the CLIENT's presence on the
    // channel, not this server's. The client re-sends its hello every time it
    // joins, and a hello arriving on a Connection that was already welcomed
    // displaces that Connection against itself. A Connection left standing
    // after the client went away also reads as "attached", which is what
    // decides whether a phone is rung for a push.
    const drop = (peer: string, reason: string): void => {
      const socket = entry.sockets.get(peer)
      if (!socket) return
      socket.terminate()
      entry.sockets.delete(peer)
      log('relay connection dropped', { client_id: record.clientId, relay_url: relay.url, peer, reason })
    }
    const dropAll = (reason: string): void => {
      for (const peer of [...entry.sockets.keys()]) drop(peer, reason)
    }
    const fresh = (peer: string, reason: string): void => {
      drop(peer, reason)
      const socket = new RelayConnectionSocket(client, secret, record.clientId, peer === SOLE_PEER ? undefined : peer)
      entry.sockets.set(peer, socket)
      attachConnection(socket, 'relay', options.listener, { preVerifiedClientId: record.clientId })
      log('relay connection ready; awaiting hello', { client_id: record.clientId, relay_url: relay.url, subject: record.subject, peer, reason })
    }
    // Until the relay names a client, the channel is taken to hold one: a
    // relay that predates multi-client never names any.
    client.on('connected', () => fresh(SOLE_PEER, 'channel connected'))
    client.on('control', (msg: RelayControlMessage) => {
      if (msg.type === 'relay:push-failed') {
        // The relay could not deliver a push this server rang: no push
        // address for the phone yet (no_token), push not configured on the
        // relay (push_unavailable), or Apple refused it.
        warn('relay push failed', { client_id: record.clientId, relay_url: relay.url, reason: msg.reason ?? 'unknown', resource_id: msg.resourceId ?? '' })
      } else if (msg.type === 'relay:peer-joined' && msg.peer) {
        // A multi-client relay: every client is named, so the unnamed
        // connection has nobody to serve.
        drop(SOLE_PEER, 'the relay names its clients')
        fresh(msg.peer, 'client joined the channel')
      } else if (msg.type === 'relay:peer-left' && msg.peer) drop(msg.peer, 'client left the channel')
      else if (msg.type === 'relay:peer-reconnected') fresh(SOLE_PEER, 'client joined the channel')
      else if (msg.type === 'relay:peer-disconnected') {
        drop(SOLE_PEER, 'client left the channel')
        // Ready for the next join even if the relay's join notice is missed.
        fresh(SOLE_PEER, 'awaiting the next join')
      }
    })
    client.on('disconnected', () => {
      log('relay channel disconnected', { client_id: record.clientId, relay_url: relay.url })
      dropAll('channel disconnected')
    })
    client.connect()
    entries.set(key, entry)
    log('relay channel opened', { client_id: record.clientId, relay_url: relay.url, subject: record.subject, auth: relay.oidc ? 'oidc' : 'psk' })
  }

  const open = (relay: ServerRelayConfig, record: CredentialClientRecord): void => {
    const key = entryKey(relay.url, record.clientId)
    if (entries.has(key) || opening.has(key)) return
    const secret = credentialsStore().secretFor(record.clientId)
    if (!secret) {
      warn('relay channel skipped: stored secret is undecodable', { client_id: record.clientId, relay_url: relay.url })
      return
    }
    const channelId = deriveChannelId(secret)
    if (!relay.oidc) {
      start(key, relay, record, secret, new RelayClient({ relayUrl: relay.url, apiKey: relay.psk, channelId, multiClient: true }))
      return
    }

    // An OIDC relay: join with a token from the operator's own tenant, and
    // announce the device's identity so the relay admits it from another.
    // The announcement needs the relay's issuer list, so the channel opens
    // only once the relay has answered.
    const deps = options.oidc
    if (!deps) {
      warn('relay channel skipped: the relay authenticates with OIDC and this listener has no identity source', { relay_url: relay.url })
      return
    }
    opening.add(key)
    void deps.probe(relay.url)
      .then((config) => {
        if (closed) return
        if (!config) {
          warn('relay channel deferred: the relay did not report its auth configuration', { client_id: record.clientId, relay_url: relay.url, retry_ms: OIDC_PROBE_RETRY_MS })
          retryTimer ??= setTimeout(() => {
            retryTimer = null
            refresh()
          }, OIDC_PROBE_RETRY_MS)
          retryTimer.unref?.()
          return
        }
        const announceTrust = announceForDevice(config, record.relayIdentity, relay.url)
        start(key, relay, record, secret, new RelayClient({ relayUrl: relay.url, apiKey: '', channelId, multiClient: true, ...joinFor(relay.url, deps), announceTrust }))
      })
      .catch((err: unknown) => warn('relay channel open failed', { client_id: record.clientId, relay_url: relay.url, error: String(err) }))
      .finally(() => opening.delete(key))
  }

  const closeEntry = (entry: RelayChannelEntry, reason: string): void => {
    for (const socket of entry.sockets.values()) socket.close(1000, reason)
    entry.sockets.clear()
    entry.client.disconnect()
    entries.delete(entry.key)
    log('relay channel closed', { client_id: entry.clientId, relay_url: entry.relayUrl, reason })
  }

  const refresh = (): void => {
    // Every live pairing gets a channel, phone or desktop alike.
    //
    // This used to skip a phone that also had a `settings.pairedDevices`
    // record, because the `desktop_*` transport held that same channel id and
    // a relay keeps one host per channel, so the two would have knocked each
    // other off in turn. That transport is deleted and the join below is now
    // the only thing that opens a phone's channel -- but the paired-device
    // record deliberately survives as the migration's source, so the skip
    // matched every migrated phone and left it with no channel at all. Off
    // the LAN such a phone sent its hello into a channel this server had
    // never joined, and waited for a welcome that could not come.
    const records = credentialsStore().list().filter((r) => r.revokedAt === null)
    const wanted = new Set<string>()
    for (const relay of options.relays) {
      if (!relay.psk && !relay.oidc) {
        warn('relay skipped: no psk resolved and the relay is not marked as OIDC', { relay_url: relay.url })
        continue
      }
      for (const record of records) {
        wanted.add(entryKey(relay.url, record.clientId))
        open(relay, record)
      }
    }
    for (const entry of [...entries.values()]) {
      if (!wanted.has(entry.key)) closeEntry(entry, 'client revoked or relay removed')
    }
    log('relay channels reconciled', { relay_count: options.relays.length, client_count: records.length, channel_count: entries.size })
  }

  /**
   * Rings the phones this push is for: one sealed doorbell frame per relay
   * channel, with the push fields and that phone's own push address beside it
   * in plaintext. A push about a conversation reaches only the devices of the
   * people who may see that conversation (`tabIdVisibleToSubject`, the same
   * rule its live events follow); a push that names no conversation is
   * Environment-wide. A relay forwards a frame when the phone is on the
   * channel and pushes when it is not, so a phone that is attached anywhere
   * (LAN included) is skipped here and gets the event itself instead.
   */
  const ring: PushRinger = (push, traceparent) => {
    const attached = new Set(connectionRegistry.all().filter((conn) => !conn.isClosed && conn.pairedClientId !== null).map((conn) => conn.pairedClientId))
    const doorbell = encodeFrame({ type: 'studio_event', channel: PUSH_DOORBELL_CHANNEL, payload: { tabId: push.pushTabId ?? null } })
    const tabId = push.pushTabId ?? ''
    let rung = 0
    for (const entry of entries.values()) {
      const record = credentialsStore().get(entry.clientId)
      if (!record || record.kind !== 'mobile' || record.revokedAt !== null) continue
      const fields = { client_id: entry.clientId, relay_url: entry.relayUrl, tab_id: tabId, kind: push.notifyKind ?? '' }
      if (tabId && !tabIdVisibleToSubject(tabId, record.subject)) {
        debug('push not rung: not this person\'s conversation', fields)
        continue
      }
      if (attached.has(entry.clientId)) {
        log('push not rung: the phone is attached', fields)
        continue
      }
      if (!record.push) {
        warn('push not rung: the phone has not registered a push address', fields)
        continue
      }
      entry.client.send(JSON.parse(sealRelayFrame(doorbell, entry.secret, { ...push, pushToken: record.push.token, pushEnv: record.push.env }, traceparent)) as WireMessage)
      rung++
      log('push doorbell sent', { ...fields, apns_env: record.push.env })
    }
    return rung
  }
  setPushRinger(ring)

  const handle: RelayStudioListenersHandle = {
    refresh,
    channelCount: () => entries.size,
    close(): void {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      for (const entry of [...entries.values()]) closeEntry(entry, 'shutdown')
      if (active === handle) {
        setPushRinger(null)
        active = null
      }
    },
  }
  active = handle
  refresh()
  return handle
}

/** Opens channels for clients paired since the last reconciliation. No-op when no relay listener runs. */
export function refreshRelayStudioClients(): void {
  if (!active) {
    log('relay refresh requested with no relay listener running')
    return
  }
  active.refresh()
}
