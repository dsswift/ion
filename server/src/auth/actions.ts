/**
 * `auth.*` `studio_action`s (manifest requirement, admin scope):
 * `auth.createPairingLink{scopes?, label}`, `auth.listClients`,
 * `auth.createOwnPairingLink{scopes?, label}` (a link for the caller's own
 * devices, `conversations:read`),
 * `environment.devices` (the caller's own devices, `conversations:read`),
 * `auth.revokeClient{clientId}`, `auth.createPairingChannel{relayUrl}`,
 * `auth.cancelPairingChannel{channelId}`, `oidc.token{scope,audience}`, and
 * `device.registerPush{token, env}` (a paired phone telling the server where
 * it receives pushes; the server owns that address from then on)
 * (spec 12: the desktop's `token-source.ts` asks the LOCAL server for a
 * bearer token to authenticate an OUTBOUND connection to a remote server;
 * the server forwards the request to the engine's own `oidc_token` command).
 *
 * A separate registry from `protocol/actions.ts`'s `ACTIONS`
 * (`@ion/shared/studio-wire/actions`'s `FORWARDED_ACTIONS`): those are
 * mirror-store actions that run `useSessionStore.getState()[action](...)` --
 * every `auth.*`/`oidc.*` action here is server-only bookkeeping with no
 * session-store equivalent and no desktop-mirror classification to make.
 * `protocol/actions.ts#handleAction` checks this table first.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { SCOPES } from '@ion/shared/studio-wire/types'
import { connectionRegistry, type Connection } from '../protocol/connection'
import { currentServerConfig, isSharedTenancy } from '../config/current'
import { isValidPairAsName } from '../identity/paired-subject'
import { getSignedInIdentity } from '../oauth/entra-flow'
import { pairingAdvertiseUrl } from '../config/server-config'
import { credentialsStore, type CredentialClientRecord } from './credentials-store'
import { createPairingLink, listClients, revokeClient, type PairingRelayAdvertise } from './pairing-links'
import { connectedSince, devicesOf } from './devices'
import { effectiveRelays, advertisedRelays } from './relay-advertise'
import { createPairingChannel, cancelPairingChannel } from './pairing-channels'
import { engineBridge } from '../state'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-actions', msg, fields)
}

export type AuthActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; refusal?: { code: string; message: string } }
  | { ok: false; error: { code: string; message: string } }

export interface AuthActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => AuthActionOutcome | Promise<AuthActionOutcome>
}

function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
}

function firstArgObject(args: unknown[]): Record<string, unknown> {
  const a = args[0]
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}

/**
 * Strips `secretRef` (the encrypted shared secret) and the push token before a
 * client record leaves the process over the wire. The token addresses the
 * phone directly, so a devices list shows only that one is registered.
 */
function redactClient(record: CredentialClientRecord): Omit<CredentialClientRecord, 'secretRef' | 'push'> & { push?: { env: string; updatedAt: number } } {
  const { secretRef: _secretRef, push, ...rest } = record
  return push ? { ...rest, push: { env: push.env, updatedAt: push.updatedAt } } : rest
}

/** An APNs device token: hex, 64 characters today, with room for Apple to lengthen it. */
const APNS_TOKEN = /^[0-9a-f]{64,200}$/

export const AUTH_ACTIONS: Record<string, AuthActionSpec> = {
  // [{ token, env }] -> true
  // A paired phone reports where it receives pushes: on every connection,
  // over any transport, and whenever the address changes. It lands on the
  // phone's own pairing record, so pushes reach it without the phone ever
  // having joined a relay. The record is the connection's own pairing; a
  // client can never name another device's.
  'device.registerPush': {
    requiredScope: 'conversations:read',
    handler: (conn, args) => {
      const clientId = conn.pairedClientId
      if (!clientId) {
        warn('push address refused: the connection is not a paired device', { connection_id: conn.id })
        return { ok: false, refusal: { code: 'not_paired', message: 'only a paired device can register a push address' } }
      }
      const record = credentialsStore().get(clientId)
      if (!record || record.revokedAt !== null || record.kind !== 'mobile') {
        warn('push address refused: the pairing is not a live phone', { client_id: clientId, kind: record?.kind ?? '', revoked: record?.revokedAt != null })
        return { ok: false, refusal: { code: 'not_a_phone', message: 'only a paired phone registers a push address' } }
      }
      const a = firstArgObject(args)
      const token = typeof a.token === 'string' ? a.token.toLowerCase() : ''
      const env = a.env === 'sandbox' || a.env === 'production' ? a.env : null
      if (!APNS_TOKEN.test(token) || env === null) {
        warn('push address refused: malformed', { client_id: clientId, token_length: token.length, env: String(a.env) })
        return { ok: false, error: { code: 'invalid_args', message: 'token must be a hex APNs token and env sandbox or production' } }
      }
      if (record.push?.token === token && record.push.env === env) {
        log('push address unchanged', { client_id: clientId, apns_env: env })
        return { ok: true, value: true }
      }
      credentialsStore().setPushAddress(clientId, { token, env })
      return { ok: true, value: true }
    },
  },
  'auth.createPairingLink': {
    requiredScope: 'admin',
    handler: (conn, args) => {
      const a = firstArgObject(args)
      const scopes = Array.isArray(a.scopes) ? a.scopes.filter(isScope) : undefined
      const label = typeof a.label === 'string' ? a.label : ''
      const subject = conn.principal?.subject ?? 'unknown'
      const config = currentServerConfig()
      // `as` names the human the joining device belongs to. On a shared
      // install there is exactly one human -- the owner -- so naming another
      // is a mistake worth refusing rather than silently ignoring.
      const as = typeof a.as === 'string' ? a.as.trim() : ''
      if (as && isSharedTenancy()) {
        warn('createPairingLink refused: --as on a shared-tenancy install', { subject, as })
        return { ok: false, error: { code: 'shared_tenancy', message: 'this install is shared tenancy: every paired device acts as the host identity, so a pairing cannot be minted for another person (set server.json tenancy.mode to "isolated" for a multi-person install)' } }
      }
      if (as && !isValidPairAsName(as)) {
        warn('createPairingLink refused: invalid --as name', { subject, as })
        return { ok: false, error: { code: 'invalid_args', message: 'as must be 1-64 characters of letters, digits, ".", "_", "@", or "-"' } }
      }
      // `relay: true` also opens a one-time pairing channel on the first
      // configured relay and names it in the link, so a client off the LAN
      // can complete the same exchange through the relay.
      let relayAdvertise: PairingRelayAdvertise | undefined
      if (a.relay === true) {
        const relay = effectiveRelays(config)[0]
        if (!relay) {
          warn('createPairingLink relay requested but no relay is configured')
          return { ok: false, error: { code: 'no_relay', message: 'no relay is configured (server.json.relays[] or the desktop relay settings)' } }
        }
        const channel = createPairingChannel(relay.url, relay.psk, { advertisedRelays: () => advertisedRelays(config) })
        relayAdvertise = { url: relay.url, channel: channel.channelId.replace(/^pairing:/, ''), key: config.oidc ? undefined : relay.psk }
      }
      const result = createPairingLink({ subject, scopes: conn.scopes }, { scopes, label, ...(as ? { as } : {}) }, config.pairing.defaultScopes, { url: pairingAdvertiseUrl(config), label: config.label }, relayAdvertise)
      if (!result.ok) {
        return { ok: false, refusal: { code: result.refusal, message: 'requested scopes exceed your granted scopes' } }
      }
      return { ok: true, value: result.value }
    },
  },
  // [{ scopes?, label? }] -> { url, code, expiresAt }
  // A link that pairs one of the CALLER's own devices, readable without
  // admin: the device acts as the caller (the link carries the caller's own
  // subject) and gets only scopes the caller holds, never admin. Naming
  // another person (`as`) and opening a relay channel stay with
  // `auth.createPairingLink`.
  'auth.createOwnPairingLink': {
    requiredScope: 'conversations:read',
    handler: (conn, args) => {
      const subject = conn.principal?.subject
      if (!subject) {
        warn('own pairing link refused: the connection has no principal', { connection_id: conn.id })
        return { ok: false, refusal: { code: 'no_principal', message: 'this connection does not act as a person' } }
      }
      const a = firstArgObject(args)
      if (a.as !== undefined || a.relay !== undefined) {
        warn('own pairing link refused: as or relay needs admin', { connection_id: conn.id, subject, has_as: a.as !== undefined, has_relay: a.relay !== undefined })
        return { ok: false, refusal: { code: 'admin_required', message: 'pairing a device for another person or through a relay needs admin (auth.createPairingLink)' } }
      }
      // On a shared install every paired device acts as the host identity,
      // whoever minted its link: a link from anyone but an admin would hand
      // its device the owner's identity.
      if (isSharedTenancy() && !conn.scopes.includes('admin')) {
        warn('own pairing link refused: shared tenancy', { connection_id: conn.id, subject })
        return { ok: false, refusal: { code: 'shared_tenancy', message: 'this install is shared tenancy: every paired device acts as the host identity, so only an admin may pair one' } }
      }
      const scopes = Array.isArray(a.scopes) ? a.scopes.filter(isScope) : undefined
      const label = typeof a.label === 'string' ? a.label : ''
      const config = currentServerConfig()
      const result = createPairingLink({ subject, scopes: conn.scopes }, { scopes, label, forSubject: subject }, config.pairing.defaultScopes, { url: pairingAdvertiseUrl(config), label: config.label })
      if (!result.ok) {
        warn('own pairing link refused: scope', { connection_id: conn.id, subject, caller_scopes: conn.scopes, requested: scopes ?? [] })
        return { ok: false, refusal: { code: result.refusal, message: 'requested scopes exceed your granted scopes' } }
      }
      log('own pairing link minted', { connection_id: conn.id, subject, admin: conn.scopes.includes('admin'), expires_at: result.value.expiresAt })
      return { ok: true, value: result.value }
    },
  },
  // Every pairing, with whether it is connected now.
  'auth.listClients': {
    requiredScope: 'admin',
    handler: () => {
      const live = connectionRegistry.all()
      return {
        ok: true,
        value: listClients(credentialsStore()).map((record) => {
          const since = connectedSince(record.clientId, live)
          return { ...redactClient(record), connected: since !== null, connectedAt: since }
        }),
      }
    },
  },
  // The caller's own paired devices, readable without admin: a person may
  // see which of their devices are paired and connected, never anyone else's.
  'environment.devices': {
    requiredScope: 'conversations:read',
    handler: (conn) => {
      const subject = conn.principal?.subject
      if (!subject) {
        warn('devices refused: the connection has no principal', { connection_id: conn.id })
        return { ok: false, refusal: { code: 'no_principal', message: 'this connection does not act as a person' } }
      }
      const devices = devicesOf(listClients(credentialsStore()), connectionRegistry.all(), subject, conn.pairedClientId)
      log('devices listed', { subject, count: devices.length, connected: devices.filter((d) => d.connected).length })
      return { ok: true, value: devices }
    },
  },
  'auth.revokeClient': {
    requiredScope: 'admin',
    handler: (conn, args) => {
      const a = firstArgObject(args)
      const clientId = typeof a.clientId === 'string' ? a.clientId : ''
      if (!clientId) return { ok: false, error: { code: 'invalid_args', message: 'clientId is required' } }
      // The pairing this very connection rides is not revocable from here:
      // doing so cuts off the device that is asking, which is what "remove
      // the environment" is for. Refused by name so the UI can say so.
      // `self: true` is the deliberate form (a headless client cleaning up
      // after itself); the Devices UI never sends it.
      if (conn.clientId === clientId && a.self !== true) {
        warn('revokeClient refused: a connection cannot revoke its own pairing', { client_id: clientId })
        return { ok: false, refusal: { code: 'self', message: 'this is the pairing you are connected through; forget the environment on that device instead' } }
      }
      const revoked = revokeClient(credentialsStore(), clientId)
      // A live session on the revoked pairing ends now rather than at its
      // next reconnect, so the devices list and reality agree. The close is
      // deferred one tick so the action's own result frame leaves first: a
      // client revoking itself would otherwise lose the socket before it
      // heard that the revoke succeeded.
      const doomed = connectionRegistry.all().filter((live) => live.clientId === clientId && !live.isClosed)
      const closed = doomed.length
      setImmediate(() => { for (const live of doomed) if (!live.isClosed) live.close('revoked') })
      log('client revoked', { client_id: clientId, revoked, live_sessions_closed: closed })
      return { ok: true, value: { revoked, closed } }
    },
  },
  'auth.createPairingChannel': {
    requiredScope: 'admin',
    handler: (_conn, args) => {
      const a = firstArgObject(args)
      const relayUrl = typeof a.relayUrl === 'string' ? a.relayUrl : ''
      if (!relayUrl) return { ok: false, error: { code: 'invalid_args', message: 'relayUrl is required' } }
      const relay = currentServerConfig().relays.find((r) => r.url === relayUrl)
      if (!relay) {
        warn('createPairingChannel refused: relayUrl not in server.json relays[]', { relay_url: relayUrl })
        return { ok: false, error: { code: 'unknown_relay', message: `relayUrl ${relayUrl} is not configured in server.json` } }
      }
      const result = createPairingChannel(relay.url, relay.psk)
      log('pairing channel action ran', { channel_id: result.channelId, relay_url: relayUrl })
      return { ok: true, value: result }
    },
  },
  'auth.cancelPairingChannel': {
    requiredScope: 'admin',
    handler: (_conn, args) => {
      const a = firstArgObject(args)
      const channelId = typeof a.channelId === 'string' ? a.channelId : ''
      if (!channelId) return { ok: false, error: { code: 'invalid_args', message: 'channelId is required' } }
      return { ok: true, value: { cancelled: cancelPairingChannel(channelId) } }
    },
  },
  // `oidc.token{scope, audience}` -- spec 12 `token-source.ts`: the desktop's
  // broker asks the LOCAL server for a bearer token to authenticate an
  // OUTBOUND connection (transport-tcp.ts's bearer door, or a relay-paired
  // remote), and the server forwards to the engine's own `oidc_token`
  // command exactly the way transport-init.ts's relay credential source
  // already does for iOS. `conversations:read` (rather than `admin`) because
  // any already-authenticated Studio client legitimately needs this to
  // reach a second environment -- LocalOnlyAuthPolicy grants every scope, so
  // the desktop's own local connection always satisfies it.
  'oidc.token': {
    requiredScope: 'conversations:read',
    handler: async (_conn, args) => {
      const a = firstArgObject(args)
      const scope = typeof a.scope === 'string' ? a.scope : ''
      const audience = typeof a.audience === 'string' ? a.audience : undefined
      try {
        const result = await engineBridge.request<{ accessToken?: string; expiresAt?: number }>('oidc_token', {
          oidcScope: scope || undefined,
          oidcAudience: audience,
        })
        if (!result.ok || !result.data?.accessToken) {
          warn('oidc.token: engine returned no accessToken', { scope, error: result.error })
          return { ok: false, error: { code: 'oidc_token_failed', message: result.error ?? 'the engine returned no access token' } }
        }
        log('oidc.token minted', { scope, expires_at: result.data.expiresAt })
        return { ok: true, value: { accessToken: result.data.accessToken, expiresAt: result.data.expiresAt } }
      } catch (err) {
        warn('oidc.token: engine request failed', { scope, error: String(err) })
        return { ok: false, error: { code: 'oidc_token_failed', message: String(err) } }
      }
    },
  },

  // `oidc.identity` -- who the operator of THIS server is signed in as: the
  // issuer that signed the identity and the subject there. A desktop reads
  // its own before pairing with another Environment (it tells that server
  // who will be joining its relay channel) and before joining an OIDC relay
  // (it picks the relay's entry for its own issuer). Null when signed out.
  'oidc.identity': {
    requiredScope: 'conversations:read',
    handler: async () => {
      try {
        const identity = await getSignedInIdentity()
        if (!identity || !identity.issuer || !identity.oid) {
          log('oidc.identity: no signed-in identity with an issuer', { signed_in: !!identity, has_issuer: !!identity?.issuer })
          return { ok: true, value: null }
        }
        log('oidc.identity resolved', { issuer: identity.issuer })
        return { ok: true, value: { issuer: identity.issuer, subject: identity.oid } }
      } catch (err) {
        warn('oidc.identity: engine request failed', { error: String(err) })
        return { ok: false, error: { code: 'oidc_identity_failed', message: String(err) } }
      }
    },
  },
}
