/**
 * The sign-in a device may present while it pairs.
 *
 * A pairing link proves a device was handed a one-time code. It says nothing
 * about which person holds the device. On an isolated server that gap makes
 * the device its own principal (`paired:<deviceId>`), so a person who already
 * signs in to this server in a browser pairs their phone and finds none of
 * their conversations and none of their provider credentials there.
 *
 * A device that is signed in to this server's identity provider closes the
 * gap by sending the token with the pairing: the `Authorization` header on
 * `POST /auth/pair`, or `bearer` on a relay `pair_request`. The token is
 * verified exactly as the `bearer` door verifies it, and a pairing that
 * carries one pairs as that person (`identity/paired-subject.ts`).
 *
 * A token that is present is never ignored. One that fails verification, or
 * one sent to a server that fronts no identity provider, refuses the pairing
 * rather than quietly pairing an anonymous device the person believes is them.
 */
import type { ServerOidcConfig } from '../config/server-config'
import { verifyBearer } from './bearer'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-pairing-bearer', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-pairing-bearer', msg, fields)
}

export type PairingBearerRefusal = 'invalid_bearer' | 'bearer_unverifiable'

export type PairingBearerOutcome =
  | { ok: true; subject?: string }
  | { ok: false; reason: PairingBearerRefusal }

/** The token in an `Authorization: Bearer <token>` header, or undefined when there is none. */
export function bearerFromAuthorization(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value)
  return match ? match[1] : undefined
}

/**
 * Decides who a pairing's accompanying token names. No token is no opinion:
 * the pairing proceeds exactly as it always has. A token names the person it
 * verifies as, or refuses the pairing.
 */
export async function resolvePairingBearer(token: string | undefined, oidc: ServerOidcConfig | null): Promise<PairingBearerOutcome> {
  if (!token) {
    log('pairing carried no bearer')
    return { ok: true }
  }
  if (!oidc) {
    warn('pairing refused: a bearer was sent to a server with no identity provider to verify it', { token_len: token.length })
    return { ok: false, reason: 'bearer_unverifiable' }
  }
  const result = await verifyBearer({ kind: 'bearer', token }, oidc)
  if (!result.ok) {
    warn('pairing refused: the accompanying bearer did not verify', { token_len: token.length, reason: result.reason ?? 'unknown' })
    return { ok: false, reason: 'invalid_bearer' }
  }
  log('pairing bearer verified', { subject: result.principal.subject })
  return { ok: true, subject: result.principal.subject }
}
