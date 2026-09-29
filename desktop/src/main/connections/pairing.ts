/**
 * pairing -- completes a pairing link against a remote Ion Studio Server
 * (spec 13 add-environment flow; manifest C6/C9). Two doors, one exchange:
 *
 *  - Over LAN: `POST /auth/pair` (`server/src/http/auth-pair.ts`). We send
 *    our X25519 public key and the one-time code, it answers with its public
 *    key and the `clientId` it registered us under.
 *  - Over a relay: when the link also names a relay pairing channel and the
 *    LAN address does not answer, the same request rides the channel as a
 *    `pair_request` message and the same answer comes back as a
 *    `pair_response` (`server/src/auth/pairing-channels.ts`).
 *
 * A server that offers sign-in (`oidc` on `/auth/config`) gets the person's
 * token with the pairing, as an `Authorization` header over LAN or `bearer`
 * on the relay request, so the paired device acts as that person rather than
 * as itself.
 *
 * Both ends derive the same shared secret. That secret, the clientId, and
 * the relays the server advertised are stored (encrypted) under the
 * server's environment id so `environment-connect.ts` can present a
 * `paired` credential on every later connect, over LAN or relay.
 *
 * Main-process only: the renderer hands over the pasted link and receives
 * the catalog target back; the secret never crosses the IPC boundary.
 */
import WebSocket from 'ws'
import { generateKeyPair, deriveSharedSecret } from '@ion/shared/e2e'
import { parsePairingLink, describePairingLinkFailure, type ParsedPairingRelay } from '@ion/shared/pairing-link'
import { isEnvironmentRelay, isRelayPairResponse, type EnvironmentRelay, type RelayPairRequest, type RelayIdentity } from '@ion/shared/studio-wire/relay-envelope'
import type { PairedEnvironmentTarget } from '@ion/shared/types-environments'
import { fetchAuthConfig, type AuthConfigResponse } from './transport-tcp'
import { relayJoinUrl } from './transport-relay'
import { saveCredential } from './credentials'
import { encodePairedSecret } from './paired-secret'
import { deviceId } from '../device-settings'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-pairing', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-pairing', msg, fields)
}

const PAIR_TIMEOUT_MS = 10_000

export interface PairEnvironmentRequest {
  /** The whole `ion-studio://pair?...` link, as pasted. */
  link: string
  /** Label the operator wants for this environment in the catalog; falls back to the server's own label. */
  label?: string
}

/** The sign-in a server publishes on `GET /auth/config`. */
export interface ServerSignIn {
  issuer: string
  audience: string
  scope: string
  clientId: string
}

/** Signs the person in for a server's sign-in and returns an access token. */
export type PairingSignIn = (signIn: ServerSignIn) => Promise<string>

export type PairEnvironmentResult =
  | { ok: true; target: PairedEnvironmentTarget }
  | { ok: false; error: string }

interface PairResponse {
  clientId: string
  ourPublicKey: string
  scopes: string[]
  relays?: unknown
}

/** The exchange's outcome, whichever door carried it. */
type Exchange =
  | { ok: true; body: PairResponse; door: 'lan' | 'relay' }
  | { ok: false; error: string; /** True when the LAN door could not be reached at all (as opposed to refusing). */ unreachable: boolean }

async function postPair(httpBase: string, body: Record<string, unknown>, bearer: string | undefined): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS)
  try {
    const res = await fetch(`${httpBase}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch (err) {
      warn('pair response body is not JSON', { status: res.status, error: String(err) })
    }
    return { status: res.status, body: parsed }
  } finally {
    clearTimeout(timer)
  }
}

function explainRefusal(reason: string): string {
  return reason === 'expired' ? 'The pairing link has expired (links last five minutes). Mint a new one.'
    : reason === 'used' ? 'That pairing link was already used. Mint a new one.'
    : reason === 'not_found' ? 'The server does not recognise this pairing code (it may have restarted since the link was minted). Mint a new one.'
    : reason === 'invalid_bearer' ? 'The server did not accept your sign-in. Sign in with the account this server belongs to, then try again.'
    : reason === 'bearer_unverifiable' ? 'The server cannot check sign-ins right now. Ask its owner to check its sign-in settings.'
    : `The server refused the pairing: ${reason}`
}

function isPairResponse(v: unknown): v is PairResponse {
  return !!v && typeof v === 'object' && typeof (v as PairResponse).clientId === 'string' && typeof (v as PairResponse).ourPublicKey === 'string'
}

async function exchangeOverLan(url: string, request: RelayPairRequest): Promise<Exchange> {
  let exchange: { status: number; body: unknown }
  try {
    exchange = await postPair(url, { code: request.code, peerPublicKey: request.peerPublicKey, label: request.label, kind: request.kind, deviceId: request.deviceId, ...(request.relayIdentity ? { relayIdentity: request.relayIdentity } : {}) }, request.bearer)
  } catch (err) {
    warn('pairing over LAN failed: POST /auth/pair unreachable', { url, error: String(err) })
    return { ok: false, unreachable: true, error: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (exchange.status !== 200) {
    const reason = exchange.body && typeof exchange.body === 'object' && typeof (exchange.body as { error?: unknown }).error === 'string'
      ? (exchange.body as { error: string }).error
      : `HTTP ${exchange.status}`
    warn('pairing refused by server', { url, status: exchange.status, reason, signed_in: !!request.bearer })
    return { ok: false, unreachable: false, error: explainRefusal(reason) }
  }
  if (!isPairResponse(exchange.body)) {
    warn('pairing failed: malformed /auth/pair response', { url })
    return { ok: false, unreachable: false, error: 'The server answered the pairing with an unexpected payload.' }
  }
  return { ok: true, body: exchange.body, door: 'lan' }
}

/**
 * The same exchange over the link's relay pairing channel: join the
 * one-time channel as the joining side, send the request, read one
 * response. Plaintext on purpose: this IS the key agreement, the channel is
 * single-use and minutes old, and the relay PSK gates who can join.
 */
export function exchangeOverRelay(relay: ParsedPairingRelay, request: RelayPairRequest, socketFactory: (url: string, bearer: string) => WebSocket = (url, bearer) => new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` } })): Promise<Exchange> {
  const url = relayJoinUrl(relay.url, `pairing:${relay.channel}`)
  log('pairing over relay: joining channel', { relay_url: relay.url })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: Exchange): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch (err) { warn('relay pairing socket close failed', { error: String(err) }) }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, unreachable: true, error: `The relay ${relay.url} did not answer the pairing within ${PAIR_TIMEOUT_MS / 1000}s. Is the server connected to it?` }), PAIR_TIMEOUT_MS)
    let ws: WebSocket
    try {
      ws = socketFactory(url, relay.key ?? '')
    } catch (err) {
      finish({ ok: false, unreachable: true, error: `Could not open the relay ${relay.url}: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    ws.once('open', () => ws.send(JSON.stringify(request)))
    ws.on('message', (raw: Buffer | string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        // silent-ok: a relay control frame or noise; the pair_response is a JSON object and is awaited below
        return
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string' && String((parsed as { type: string }).type).startsWith('relay:')) return
      if (!isRelayPairResponse(parsed)) {
        warn('pairing over relay: unexpected message on the channel', { relay_url: relay.url })
        return
      }
      if (!parsed.ok) {
        finish({ ok: false, unreachable: false, error: explainRefusal(parsed.error ?? 'refused') })
        return
      }
      if (typeof parsed.clientId !== 'string' || typeof parsed.ourPublicKey !== 'string') {
        finish({ ok: false, unreachable: false, error: 'The server answered the pairing with an unexpected payload.' })
        return
      }
      finish({ ok: true, door: 'relay', body: { clientId: parsed.clientId, ourPublicKey: parsed.ourPublicKey, scopes: parsed.scopes ?? [], relays: parsed.relays } })
    })
    ws.once('error', (err: Error) => finish({ ok: false, unreachable: true, error: `Relay ${relay.url}: ${err.message}` }))
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      finish({ ok: false, unreachable: true, error: res.statusCode === 401 || res.statusCode === 403 ? `The relay ${relay.url} refused the join (HTTP ${res.statusCode}); the link's relay key does not match.` : `The relay ${relay.url} refused the join: HTTP ${res.statusCode}` })
    })
    ws.once('close', () => finish({ ok: false, unreachable: true, error: `The relay ${relay.url} closed the pairing channel before answering.` }))
  })
}

/** `oidc` from `/auth/config`, when it carries every field a token needs. */
export function serverSignInFrom(config: AuthConfigResponse): ServerSignIn | null {
  const oidc = config.oidc
  if (!oidc || typeof oidc !== 'object') return null
  const { issuer, audience, scope, clientId } = oidc as Record<string, unknown>
  if (typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience || typeof scope !== 'string' || !scope) return null
  return { issuer, audience, scope, clientId: typeof clientId === 'string' ? clientId : '' }
}

/**
 * Runs the exchange. Every failure branch returns `{ok:false, error}` with
 * an operator-readable reason (and is logged); nothing here throws, because
 * the IPC handler relays the result to a dialog that shows it verbatim.
 */
export async function pairEnvironment(req: PairEnvironmentRequest, clientLabel: string, relayIdentity: RelayIdentity | null = null, signIn?: PairingSignIn): Promise<PairEnvironmentResult> {
  const parsed = parsePairingLink(req.link)
  if (!parsed.ok) {
    warn('pairing refused: link did not parse', { reason: parsed.reason })
    return { ok: false, error: describePairingLinkFailure(parsed.reason) }
  }
  const { code, url, relay } = parsed.link
  log('pairing started', { url, client_label: clientLabel, has_relay: !!relay, presents_identity: !!relayIdentity })

  // The server's config comes first: it says whether the server wants a
  // sign-in with the pairing. An address that does not answer leaves the
  // exchange below to fall back to the relay, which carries no config.
  let config: AuthConfigResponse | null = null
  try {
    config = await fetchAuthConfig(url)
  } catch (err) {
    warn('pairing: /auth/config unavailable before pairing; pairing without a sign-in', { url, error: String(err) })
  }
  const serverSignIn = config ? serverSignInFrom(config) : null
  let bearer: string | undefined
  if (serverSignIn && signIn) {
    log('pairing: server offers sign-in; signing in', { url, issuer: serverSignIn.issuer })
    try {
      bearer = await signIn(serverSignIn)
    } catch (err) {
      warn('pairing refused locally: sign-in failed', { url, error: String(err) })
      return { ok: false, error: `This server needs you to sign in before pairing: ${err instanceof Error ? err.message : String(err)}` }
    }
  } else {
    log('pairing: no sign-in sent', { url, server_offers_sign_in: !!serverSignIn, can_sign_in: !!signIn })
  }

  const keyPair = generateKeyPair()
  const request: RelayPairRequest = { type: 'pair_request', code, peerPublicKey: keyPair.publicKey.toString('base64'), label: clientLabel, kind: 'desktop', deviceId: deviceId(), ...(relayIdentity ? { relayIdentity } : {}), ...(bearer ? { bearer } : {}) }
  let exchange = await exchangeOverLan(url, request)
  if (!exchange.ok && exchange.unreachable && relay) {
    log('LAN address unreachable; pairing through the relay named in the link', { url, relay_url: relay.url })
    exchange = await exchangeOverRelay(relay, request)
  }
  if (!exchange.ok) return { ok: false, error: exchange.error }
  const body = exchange.body
  const sharedSecret = deriveSharedSecret(keyPair.secretKey, Buffer.from(body.ourPublicKey, 'base64'))
  const relays: EnvironmentRelay[] = Array.isArray(body.relays) ? body.relays.filter(isEnvironmentRelay) : []

  let environmentId = ''
  let serverLabel = ''
  if (exchange.door === 'lan') {
    try {
      const known = config ?? await fetchAuthConfig(url)
      environmentId = typeof known.environmentId === 'string' ? known.environmentId : ''
      serverLabel = typeof known.label === 'string' ? known.label : ''
    } catch (err) {
      warn('pairing completed but /auth/config failed; cannot learn environment id', { url, error: String(err) })
      return { ok: false, error: `Paired, but could not read the server identity from ${url}/auth/config: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!environmentId) {
      warn('pairing completed but /auth/config carried no environmentId', { url })
      return { ok: false, error: 'Paired, but the server did not report an environment id.' }
    }
  } else {
    // No HTTP reachable to ask `/auth/config`; the environment id is learned
    // from the first `studio_welcome` over the relay (`catalog.ts` keys the
    // entry by it once known). The credential is stored under the clientId
    // until then, which is what the target's `credentialRef` names.
    environmentId = body.clientId
    serverLabel = parsed.link.label
  }

  saveCredential(environmentId, 'paired', encodePairedSecret({ clientId: body.clientId, sharedSecret, relays }))
  const label = (req.label ?? '').trim() || parsed.link.label || serverLabel || url
  const target: PairedEnvironmentTarget = exchange.door === 'lan'
    ? { kind: 'paired', label, url, credentialRef: environmentId, via: 'lan', environmentId, ...(relays.length > 0 ? { relayUrls: relays.map((r) => r.url) } : {}) }
    : { kind: 'paired', label, url, credentialRef: environmentId, via: 'relay', relayUrls: relays.length > 0 ? relays.map((r) => r.url) : [relay!.url] }
  log('pairing completed', { environment_id: environmentId, client_id: body.clientId, label, door: exchange.door, signed_in: !!bearer, relay_count: relays.length, scope_count: Array.isArray(body.scopes) ? body.scopes.length : 0 })
  return { ok: true, target }
}
