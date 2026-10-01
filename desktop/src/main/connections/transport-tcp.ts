/**
 * transport-tcp — connects to a remote server's TCP Studio wire listener
 * over `bearer` or `paired` credentials (spec 12). `bearer` rides an
 * `Authorization` header on the WebSocket upgrade; `paired` proves
 * possession of a shared secret via HMAC over a server-issued nonce fetched
 * from `GET /auth/config` (manifest contract C6).
 */
import WebSocket from 'ws'
import { createAuthProof } from '@ion/shared/e2e'
import type { StudioCredential } from '@ion/shared/studio-wire/types'
import { SealedStudioSocket } from './sealed-studio-socket'
import { keepSocketAlive } from './socket-keepalive'
import { guardEarlyError } from './early-error-guard'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-transport-tcp', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-transport-tcp', msg, fields)
}

/**
 * A catalog target's `url` is the server's HTTP base (`http(s)://host:port`,
 * what `/auth/config` and `/auth/pair` are fetched against). The Studio wire
 * rides a WebSocket upgrade on that SAME listener (`server/src/protocol/
 * listener.ts` attaches `ws` to the health server), so the socket URL is the
 * base with the scheme swapped and `/studio` appended. A `ws(s)://` value is
 * accepted too and mapped back for the HTTP calls, so a target written
 * either way dials correctly.
 */
export function serverHttpBase(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`unsupported server url scheme ${parsed.protocol} in ${url}`)
  parsed.pathname = parsed.pathname.replace(/\/studio\/?$/, '/')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

export function serverWsUrl(url: string): string {
  const parsed = new URL(serverHttpBase(url))
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/studio`
  return parsed.toString()
}

export interface AuthConfigResponse {
  nonce: string
  [key: string]: unknown
}

/** GET {httpBaseUrl}/auth/config and return the parsed body (manifest contract C6). */
export async function fetchAuthConfig(httpBaseUrl: string): Promise<AuthConfigResponse> {
  const url = `${serverHttpBase(httpBaseUrl)}/auth/config`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET /auth/config failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as Partial<AuthConfigResponse>
  if (typeof body.nonce !== 'string') {
    throw new Error('/auth/config response is missing a nonce')
  }
  return body as AuthConfigResponse
}

/** Builds a `paired` credential's HMAC proof over a fetched nonce. */
export function buildPairedCredential(clientId: string, nonce: string, sharedSecret: Buffer): StudioCredential {
  return { kind: 'paired', clientId, proof: createAuthProof(nonce, sharedSecret) }
}

/** Builds a `bearer` credential from a minted access token. */
export function buildBearerCredential(accessToken: string): StudioCredential {
  return { kind: 'bearer', token: accessToken }
}

/**
 * Opens a WebSocket to a remote server's TCP Studio wire listener.
 * `bearerToken`, when supplied, rides on the upgrade request's Authorization
 * header — the studio_hello frame carries the credential itself (this is a
 * defense-in-depth header, not a substitute for the hello handshake).
 */
export function connectTcp(url: string, bearerToken?: string): WebSocket {
  const wsUrl = serverWsUrl(url)
  log('opening TCP Studio connection', { url: wsUrl, has_bearer_header: !!bearerToken })
  const ws = bearerToken ? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${bearerToken}` } }) : new WebSocket(wsUrl)
  return keepSocketAlive(guardEarlyError(ws, wsUrl), wsUrl)
}

/**
 * Opens a SEALED connection to a server's TCP listener for a paired client.
 *
 * The listener is plain `ws://`, so a paired session is otherwise readable by
 * anything on the network path. `?client=<clientId>` tells the server which
 * pairing secret to open frames with; every frame either way is then an
 * AES-256-GCM envelope. The hello's nonce proof is still sent, inside it.
 */
export function connectSealedTcp(url: string, clientId: string, sharedSecret: Buffer): SealedStudioSocket {
  const wsUrl = new URL(serverWsUrl(url))
  wsUrl.searchParams.set('client', clientId)
  log('opening sealed TCP Studio connection', { url: serverWsUrl(url), client_id: clientId })
  return new SealedStudioSocket(new WebSocket(wsUrl.toString()), sharedSecret, { label: serverWsUrl(url) })
}

/** Whether `config` says the server opens sealed frames on its TCP listener. A server that predates sealed TCP omits the field. */
export function serverSealsTcp(config: AuthConfigResponse): boolean {
  return config.sealedTcp === true
}

/** Warns once when a target is configured for `paired` but the server never advertised an OIDC nonce. */
export function requireNonce(config: AuthConfigResponse): string {
  if (!config.nonce) {
    warn('auth/config response carried no usable nonce for a paired credential')
    throw new Error('auth/config response carried no usable nonce')
  }
  return config.nonce
}
