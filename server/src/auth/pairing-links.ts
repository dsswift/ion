/**
 * One-time pairing links with scope delegation (manifest requirement:
 * `auth.createPairingLink{scopes?, label}` -> `{url, code, expiresAt}`;
 * requested scopes must be a subset of the caller's scopes, default =
 * `pairing.defaultScopes`, narrowed to the caller's own for a caller without
 * `admin`) and pairing completion (DH exchange reusing
 * `remote/crypto.ts`/`remote/pairing.ts`'s primitives, producing a
 * `credentials.json` client record per manifest C9).
 */
import { randomBytes } from 'crypto'
import type { Scope } from '@ion/shared/studio-wire/types'
import { generateKeyPair, deriveSharedSecret, deriveChannelId } from '../remote/crypto'
import type { CredentialsStore, CredentialClientKind, CredentialClientRecord } from './credentials-store'
import { log as _log, warn as _warn } from '../logger'
import { isSharedTenancy } from '../config/current'
import { resolvePairedSubject, userSubject } from '../identity/paired-subject'
import { normalizeDiscoveryCode } from '../discovery/code'
import type { RelayIdentity } from '@ion/shared/studio-wire/relay-envelope'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-pairing-links', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-pairing-links', msg, fields)
}

const LINK_TTL_MS = 5 * 60 * 1000

interface PairingLinkRecord {
  code: string
  scopes: Scope[]
  label: string
  /** The human this link pairs a device for (`user:<name>`, or a verified subject as-is), on an isolated-tenancy install. */
  subject?: string
  createdBySubject: string
  expiresAt: number
  used: boolean
}

/** In-memory only, per manifest ("one-time"): a link that outlives a process restart has no meaning to defend. */
const links = new Map<string, PairingLinkRecord>()

export interface PairingCaller {
  subject: string
  scopes: Scope[]
}

export interface CreatePairingLinkRequest {
  scopes?: Scope[]
  label?: string
  /** The human the joining device belongs to (`pair --as <name>`); the device then acts as `user:<name>`. Isolated tenancy only. */
  as?: string
  /**
   * The verified subject of the person the joining device belongs to, taken
   * as-is (a bearer's raw `sub` included). Set by `auth.createOwnPairingLink`
   * from the caller's own principal, never from client input; wins over `as`.
   */
  forSubject?: string
}

export type CreatePairingLinkResult =
  | { ok: true; value: { url: string; code: string; expiresAt: number } }
  | { ok: false; refusal: 'scope' }

/**
 * What a minted link tells the joining client about THIS server: the HTTP
 * base URL to dial (`config/server-config.ts#pairingAdvertiseUrl`) and the
 * server's own label, offered as the default catalog label on the client.
 */
export interface PairingAdvertise {
  url: string
  label: string
}

/** URL scheme the desktop registers for deep links; a pairing link rides it so a pasted or clicked link opens the add-environment flow. */
export const PAIRING_LINK_SCHEME = 'ion-studio:'

/**
 * Builds the link a client consumes: `ion-studio://pair?code=…&url=…&env=…`.
 * `url` is the server's advertised HTTP base; `env` is the server's label.
 * Query encoding via URLSearchParams so a label with spaces or a URL with a
 * port survives the round trip.
 */
/**
 * A relay pairing channel the link also names, so a client that cannot
 * reach `url` (off the LAN) can complete the same exchange through the
 * relay: `relay` is the relay's URL, `channel` the channel's hex id
 * (`pairing-channels.ts`), and `relayKey` the relay's PSK when it runs in
 * PSK mode. The link is already a bearer secret (its code opens a pairing);
 * the key rides the same protection and the channel dies in five minutes.
 */
export interface PairingRelayAdvertise {
  url: string
  channel: string
  key?: string
}

export function formatPairingLink(code: string, advertise: PairingAdvertise, relay?: PairingRelayAdvertise): string {
  const params = new URLSearchParams({ code, url: advertise.url, env: advertise.label })
  if (relay) {
    params.set('relay', relay.url)
    params.set('channel', relay.channel)
    if (relay.key) params.set('relayKey', relay.key)
  }
  return `${PAIRING_LINK_SCHEME}//pair?${params.toString()}`
}

/**
 * True when every entry of `requested` is already granted to `caller` (an
 * `admin` caller may delegate any scope, including `admin` itself).
 */
function isSubsetOfCallerScopes(requested: readonly Scope[], caller: PairingCaller): boolean {
  if (caller.scopes.includes('admin')) return true
  return requested.every((s) => caller.scopes.includes(s))
}

/**
 * The scopes a link grants when the request names none: the server's
 * pairing defaults, narrowed for a caller without `admin` to what that caller
 * holds itself, so delegation never widens a person's reach.
 */
function defaultScopesFor(caller: PairingCaller, pairingDefaultScopes: readonly Scope[]): Scope[] {
  if (caller.scopes.includes('admin')) return [...pairingDefaultScopes]
  return pairingDefaultScopes.filter((s) => s !== 'admin' && caller.scopes.includes(s))
}

/**
 * Mints a one-time pairing link. `caller` is the requesting connection's own
 * principal/scopes -- passed explicitly (rather than read off a `Connection`)
 * so this function is testable independent of the wire's own admin-scope gate
 * on the `auth.createPairingLink` action itself.
 */
export function createPairingLink(caller: PairingCaller, req: CreatePairingLinkRequest, pairingDefaultScopes: readonly Scope[], advertise: PairingAdvertise, relay?: PairingRelayAdvertise): CreatePairingLinkResult {
  const requested = req.scopes && req.scopes.length > 0 ? req.scopes : defaultScopesFor(caller, pairingDefaultScopes)
  if (requested.length === 0) {
    warn('pairing link refused: the caller holds none of the default pairing scopes', { subject: caller.subject, caller_scopes: caller.scopes, default_scopes: pairingDefaultScopes })
    return { ok: false, refusal: 'scope' }
  }
  if (!isSubsetOfCallerScopes(requested, caller)) {
    warn('pairing link refused: requested scopes exceed caller scopes', { subject: caller.subject, requested, caller_scopes: caller.scopes })
    return { ok: false, refusal: 'scope' }
  }

  const code = randomBytes(16).toString('hex')
  const expiresAt = Date.now() + LINK_TTL_MS
  const linkSubject = req.forSubject ?? (req.as?.trim() ? userSubject(req.as.trim()) : undefined)
  links.set(code, { code, scopes: requested, label: req.label ?? '', ...(linkSubject ? { subject: linkSubject } : {}), createdBySubject: caller.subject, expiresAt, used: false })
  log('pairing link created', { subject: caller.subject, scope_count: requested.length, label: req.label ?? '', for_subject: linkSubject ?? '', advertise_url: advertise.url, relay_url: relay?.url ?? '', expires_at: expiresAt })

  return { ok: true, value: { url: formatPairingLink(code, advertise, relay), code, expiresAt } }
}

type PairingCompletionListener = (record: { clientId: string; kind: CredentialClientKind; code: string }) => void
const completionListeners = new Set<PairingCompletionListener>()

/** Told of every completion attempt that named no live code. `discovery/window.ts` counts these to burn a short code under guessing. */
type PairingFailureListener = (attempt: { reason: 'not_found' | 'used' | 'expired' }) => void
const failureListeners = new Set<PairingFailureListener>()

export function onPairingAttemptFailed(listener: PairingFailureListener): () => void {
  failureListeners.add(listener)
  return () => failureListeners.delete(listener)
}

function reportFailure(reason: 'not_found' | 'used' | 'expired'): void {
  for (const listener of failureListeners) {
    try {
      listener({ reason })
    } catch (err) {
      warn('pairing failure listener threw', { error: String(err) })
    }
  }
}

/**
 * Registers a caller-chosen one-time code (the short discovery code) with
 * its own lifetime. Same record, same single-use completion as a link; only
 * the code's shape and lifetime differ. Scope delegation is checked exactly
 * as for a link.
 */
export function registerPairingCode(caller: PairingCaller, code: string, scopes: Scope[], label: string, expiresAt: number): boolean {
  if (!isSubsetOfCallerScopes(scopes, caller)) {
    warn('pairing code refused: requested scopes exceed caller scopes', { subject: caller.subject, requested: scopes, caller_scopes: caller.scopes })
    return false
  }
  links.set(code, { code, scopes, label, createdBySubject: caller.subject, expiresAt, used: false })
  log('pairing code registered', { subject: caller.subject, scope_count: scopes.length, code_length: code.length, expires_at: expiresAt })
  return true
}

/** Forgets a code so it can no longer be completed. */
export function revokePairingCode(code: string): void {
  if (links.delete(code)) log('pairing code revoked', { code_length: code.length })
}

/**
 * Subscribes to every successful pairing completion (LAN or relay). The
 * relay listener uses this to open a channel for a client the moment it is
 * paired, rather than at the next boot.
 */
export function onPairingCompleted(listener: PairingCompletionListener): () => void {
  completionListeners.add(listener)
  return () => completionListeners.delete(listener)
}

/** TEST ONLY. Clears in-memory pairing-link state between test cases. */
export function _resetPairingLinksForTest(): void {
  links.clear()
}

export interface CompletePairingInput {
  code: string
  /** The joining peer's X25519 public key, base64-encoded. */
  peerPublicKey: string
  label: string
  kind: CredentialClientKind
  /** Set when a bearer accompanied the pairing (manifest: "subject: local principal unless a bearer accompanied the pairing"). */
  accompanyingSubject?: string
  /** The device's stable id, so a re-pair replaces the device's earlier record. */
  deviceId?: string
  /** Who the device is signed in as, for the relay announcement on its channel. */
  relayIdentity?: RelayIdentity
}

export type CompletePairingResult =
  | { ok: true; clientId: string; ourPublicKey: string; scopes: Scope[] }
  | { ok: false; reason: 'not_found' | 'used' | 'expired' }

/**
 * Completes a pairing link's DH exchange (manifest: "DH per pairing.ts") and
 * registers the resulting client in `store`. The link is single-use: a
 * second call with the same code -- even a well-formed one -- is refused.
 */
export function completePairing(store: CredentialsStore, input: CompletePairingInput): CompletePairingResult {
  // A typed discovery code arrives with or without its dash, in any case.
  const code = normalizeDiscoveryCode(input.code) ?? input.code
  const link = links.get(code)
  if (!link) {
    warn('pairing completion refused: unknown code', { code_length: code.length })
    reportFailure('not_found')
    return { ok: false, reason: 'not_found' }
  }
  if (link.used) {
    warn('pairing completion refused: code already used')
    reportFailure('used')
    return { ok: false, reason: 'used' }
  }
  if (Date.now() > link.expiresAt) {
    links.delete(code)
    warn('pairing completion refused: code expired')
    reportFailure('expired')
    return { ok: false, reason: 'expired' }
  }

  const keyPair = generateKeyPair()
  const peerPublicKey = Buffer.from(input.peerPublicKey, 'base64')
  const sharedSecret = deriveSharedSecret(keyPair.secretKey, peerPublicKey)
  const clientId = deriveChannelId(sharedSecret).slice(0, 16)
  // The principal a paired device acts as -- see `identity/paired-subject.ts`.
  const subject = resolvePairedSubject({ clientId, sharedTenancy: isSharedTenancy(), accompanyingSubject: input.accompanyingSubject, linkSubject: link.subject, deviceId: input.deviceId })

  store.add({ clientId, secret: sharedSecret, scopes: link.scopes, subject, kind: input.kind, label: input.label, deviceId: input.deviceId, relayIdentity: input.relayIdentity })
  for (const listener of completionListeners) {
    try {
      listener({ clientId, kind: input.kind, code })
    } catch (err) {
      warn('pairing completion listener threw', { client_id: clientId, error: String(err) })
    }
  }
  link.used = true
  log('pairing completed', { client_id: clientId, subject, kind: input.kind, scope_count: link.scopes.length })

  return { ok: true, clientId, ourPublicKey: keyPair.publicKey.toString('base64'), scopes: link.scopes }
}

export function listClients(store: CredentialsStore): CredentialClientRecord[] {
  return store.list()
}

export function revokeClient(store: CredentialsStore, clientId: string): boolean {
  return store.revoke(clientId)
}
