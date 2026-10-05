/**
 * `bearer` credential verification (manifest requirement: verify with `jose`;
 * `principal = { subject: sub, provider: 'entra' (from issuer host), kind:
 * 'operator', username: preferred_username, displayName: name }`; scopes =
 * union of `rolesToScopes[role]` for each `roles` claim, else `defaultScopes`;
 * `allowedSubjects` when non-empty must contain `sub`; `scp` must include
 * `oidc.scope`).
 *
 * Uses `jose`'s `jwtVerify` + `createRemoteJWKSet` rather than porting
 * `relay/oidc.go` to TypeScript (a second hand-written JWKS cache, RSA-only) --
 * see specs/08-server-auth.md "Alternatives Considered". `createRemoteJWKSet`
 * already gives the "JWKS fetched at most once per key rotation" nonfunctional
 * requirement via its own built-in cache + cooldown; this module caches the
 * `RemoteJWKSet` function itself per issuer so a second bearer from the same
 * issuer never re-runs OIDC discovery.
 */
import { jwtVerify, createRemoteJWKSet, errors as joseErrors, type JWTVerifyGetKey } from 'jose'
import type { Scope } from '@ion/shared/studio-wire/types'
import type { ServerOidcConfig } from '../config/server-config'
import type { AuthResult } from '../protocol/hello'
import { log as _log, warn as _warn, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-bearer', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-bearer', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('auth-bearer', msg, fields)
}

export interface BearerCredential {
  kind: 'bearer'
  token: string
}

/** Per-issuer cached `RemoteJWKSet`, so discovery + JWKS-endpoint construction runs once per issuer for the life of the process. */
const jwksCache = new Map<string, JWTVerifyGetKey>()

/** TEST ONLY. Clears the per-issuer JWKS cache between test cases. */
export function _resetBearerJwksCacheForTest(): void {
  jwksCache.clear()
}

/**
 * Resolves the JWKS endpoint for `issuer` via OIDC discovery
 * (`/.well-known/openid-configuration`'s `jwks_uri`), falling back to the
 * conventional `/.well-known/jwks.json` path when discovery fails or omits
 * `jwks_uri` -- discovery unavailability must never make an otherwise-correct
 * issuer permanently unusable.
 */
async function resolveJwksUri(issuer: string): Promise<string> {
  const base = issuer.replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = (await res.json()) as { jwks_uri?: string }
      if (typeof data.jwks_uri === 'string' && data.jwks_uri) return data.jwks_uri
    } else {
      warn('oidc discovery returned non-200; falling back to conventional jwks.json path', { issuer, status: res.status })
    }
  } catch (err) {
    warn('oidc discovery failed; falling back to conventional jwks.json path', { issuer, error: String(err) })
  }
  return `${base}/.well-known/jwks.json`
}

async function getJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const cached = jwksCache.get(issuer)
  if (cached) return cached
  const jwksUri = await resolveJwksUri(issuer)
  const jwks = createRemoteJWKSet(new URL(jwksUri))
  jwksCache.set(issuer, jwks)
  return jwks
}

/** The identity-provider name stamped on `principal.provider`, derived from the issuer's host. */
export function providerFromIssuer(issuer: string): string {
  try {
    const host = new URL(issuer).hostname
    if (host.endsWith('microsoftonline.com')) return 'entra'
    return host
  } catch {
    return 'oidc'
  }
}

/** Classifies a `jwtVerify` rejection into a refusal reason for logs (manifest: "every decision logs ... reason"). */
function classifyJwtError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token_expired'
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'aud') return 'wrong_audience'
    if (err.claim === 'iss') return 'wrong_issuer'
    return 'unauthorized'
  }
  // JWKSNoMatchingKey / JWKSMultipleMatchingKeys / JWKSTimeout / JWKSInvalid
  // all originate from `createRemoteJWKSet`'s fetch of the issuer's JWKS
  // endpoint -- an unreachable or misbehaving issuer, same class as a
  // `getJwks()` construction failure. A non-JOSEError (e.g. undici's raw
  // "fetch failed" TypeError on connection refused) is the same failure one
  // layer lower: jose never got far enough to classify the JWT itself.
  if (err instanceof joseErrors.JWKSNoMatchingKey || err instanceof joseErrors.JWKSMultipleMatchingKeys || err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
    return 'jwks_unavailable'
  }
  if (!(err instanceof joseErrors.JOSEError)) return 'jwks_unavailable'
  return 'unauthorized'
}

function scopesFromRoles(roles: string[], oidc: ServerOidcConfig): Scope[] {
  const set = new Set<Scope>()
  for (const role of roles) {
    for (const scope of oidc.rolesToScopes[role] ?? []) set.add(scope)
  }
  return set.size > 0 ? [...set] : [...oidc.defaultScopes]
}

/** Verifies a `bearer` credential against `oidc` (manifest C5's `server.json.oidc`). */
export async function verifyBearer(credential: BearerCredential, oidc: ServerOidcConfig): Promise<AuthResult> {
  const token = credential.token
  const tokenLen = token.length

  let jwks: JWTVerifyGetKey
  try {
    jwks = await getJwks(oidc.issuer)
  } catch (err) {
    error('bearer auth refused: jwks_unavailable', { issuer: oidc.issuer, token_len: tokenLen, reason: 'jwks_unavailable', error: String(err) })
    return { ok: false, reason: 'jwks_unavailable' }
  }

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, jwks, { issuer: oidc.issuer, audience: oidc.audience })
    payload = result.payload
  } catch (err) {
    const reason = classifyJwtError(err)
    warn('bearer auth refused', { issuer: oidc.issuer, audience: oidc.audience, token_len: tokenLen, reason, error: String(err) })
    return { ok: false, reason }
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  if (!sub) {
    warn('bearer auth refused: token has no sub claim', { token_len: tokenLen, reason: 'unauthorized' })
    return { ok: false, reason: 'unauthorized' }
  }

  const scpClaim = payload.scp
  const scpList = typeof scpClaim === 'string' ? scpClaim.split(/\s+/).filter(Boolean) : Array.isArray(scpClaim) ? scpClaim.filter((s): s is string => typeof s === 'string') : []
  if (!scpList.includes(oidc.scope)) {
    warn('bearer auth refused: scp claim missing required scope', { subject: sub, required_scope: oidc.scope, token_len: tokenLen, reason: 'scope' })
    return { ok: false, reason: 'scope' }
  }

  // Entra's `sub` differs per app registration, so an operator who lists a person lists the directory object id.
  const oid = typeof payload.oid === 'string' ? payload.oid : ''
  if (oidc.allowedSubjects.length > 0 && !oidc.allowedSubjects.includes(sub) && !(oid && oidc.allowedSubjects.includes(oid))) {
    warn('bearer auth refused: subject not in allowedSubjects', { subject: sub, token_len: tokenLen, reason: 'unlisted_subject' })
    return { ok: false, reason: 'unlisted_subject' }
  }

  const rolesClaim = payload.roles
  const roles = Array.isArray(rolesClaim) ? rolesClaim.filter((r): r is string => typeof r === 'string') : []
  const scopes = scopesFromRoles(roles, oidc)

  const preferredUsername = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined
  const name = typeof payload.name === 'string' && payload.name ? payload.name : preferredUsername ?? sub
  const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  // `email` is an OPTIONAL claim in Entra v2 tokens (Blind Spot #1 in the
  // multi-tenant plan): fall back to `preferred_username` only when it looks
  // like an address, so an unset app-registration claim degrades to the UPN
  // rather than to nothing -- FR-04's git author email reads this field.
  const emailClaim = typeof payload.email === 'string' ? payload.email : undefined
  const email = emailClaim ?? (preferredUsername?.includes('@') ? preferredUsername : undefined)

  log('bearer auth accepted', { subject: sub, provider: providerFromIssuer(oidc.issuer), roles, scope_count: scopes.length, token_len: tokenLen, has_email: !!email })

  return {
    ok: true,
    principal: {
      subject: sub,
      displayName: name,
      provider: providerFromIssuer(oidc.issuer),
      kind: 'operator',
      username: preferredUsername,
      email,
    },
    scopes,
    expiresAt,
    claims: { roles },
  }
}
