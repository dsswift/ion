/**
 * Server-side OAuth client for the browser Studio client's sign-in (spec 18
 * successor): the SERVER now runs the PKCE authorization-code exchange that
 * used to happen in the browser's own JS (`oidc-client-ts`), against the
 * exact same public `clientId`/`issuer`/`scope` already loaded for the
 * bearer-verification door (`ServerOidcConfig`) -- no new config surface, no
 * IdP-side registration change (the redirect URI stays `{origin}
 * /auth/callback`, only who calls it moves from the browser to this server).
 *
 * PKCE needs no client secret, so a public SPA client registration is a
 * legitimate client here even though the exchange itself now happens
 * server-side -- the security property PKCE provides (binding the token
 * response to whoever holds `verifier`) does not depend on where the
 * exchange runs.
 *
 * Pending logins (the `state` -> `{verifier, returnTo}` map) are
 * deliberately in-memory only, never persisted: a login in flight during a
 * restart just means "click sign in again," an acceptable edge case
 * distinct from `browser-session-store.ts`'s sessions, which must survive
 * one. Single-replica by design (this server pairs one-to-one with one
 * engine per environment; see ADR-033), so there is no cross-replica
 * consistency concern either.
 */
import { createHash, randomBytes } from 'crypto'
import type { ServerOidcConfig } from '../config/server-config'
import { verifyBearer } from './bearer'
import type { AuthResult } from '../protocol/hello'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('browser-oidc', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('browser-oidc', msg, fields)
}

/** How long a pending login (state -> PKCE verifier) stays valid before it is swept as abandoned. */
const PENDING_LOGIN_TTL_MS = 10 * 60_000

/** Requested in addition to the bearer door's own `oidc.scope` so the IdP issues a refresh token -- the one thing the old client-side flow never asked for, which is why every page reload needed a full redirect. */
const REFRESH_SCOPE_ADDITION = 'offline_access'

interface DiscoveryDoc {
  authorization_endpoint: string
  token_endpoint: string
}

/** Best-effort parse of an OIDC token-endpoint error body (`{error, error_description}`, no secrets) so a failed exchange logs the IdP's actual reason instead of just an HTTP status. */
async function tokenErrorBody(res: Response): Promise<{ error?: string; error_description?: string; error_codes?: number[] } | string> {
  try {
    const text = await res.text()
    try {
      return JSON.parse(text) as { error?: string; error_description?: string; error_codes?: number[] }
    } catch {
      return text
    }
  } catch (err) {
    return `<unreadable body: ${String(err)}>`
  }
}

/** Per-issuer cached discovery document (`authorization_endpoint`/`token_endpoint`) -- distinct from `bearer.ts`'s own `jwks_uri` cache, since neither module needs the other's fields. */
const discoveryCache = new Map<string, DiscoveryDoc>()

/** TEST ONLY. Clears the per-issuer discovery cache between test cases. */
export function _resetBrowserOidcDiscoveryCacheForTest(): void {
  discoveryCache.clear()
}

async function discover(issuer: string): Promise<DiscoveryDoc> {
  const cached = discoveryCache.get(issuer)
  if (cached) return cached
  const base = issuer.replace(/\/+$/, '')
  const res = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`OIDC discovery at ${base} returned ${res.status}`)
  const data = (await res.json()) as Partial<DiscoveryDoc>
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error(`OIDC discovery at ${base} is missing authorization_endpoint/token_endpoint`)
  }
  const doc: DiscoveryDoc = { authorization_endpoint: data.authorization_endpoint, token_endpoint: data.token_endpoint }
  discoveryCache.set(issuer, doc)
  return doc
}

interface PendingLogin {
  verifier: string
  returnTo: string
  createdAt: number
}

const pendingLogins = new Map<string, PendingLogin>()

function sweepExpiredLogins(): void {
  const cutoff = Date.now() - PENDING_LOGIN_TTL_MS
  for (const [state, entry] of pendingLogins) {
    if (entry.createdAt < cutoff) pendingLogins.delete(state)
  }
}

function base64url(input: Buffer): string {
  return input.toString('base64url')
}

/** PKCE `code_verifier` + its S256 `code_challenge`. */
export function generatePkcePair(): { verifier: string; challengeS256: string } {
  const verifier = base64url(randomBytes(32))
  const challengeS256 = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challengeS256 }
}

export interface BeginLoginResult {
  authorizeUrl: string
  state: string
}

/** Redirect URI both `beginLogin` and `completeLogin` use -- must exactly match the IdP's registered value for `clientId`, unchanged from the browser's own former PKCE flow. */
export function redirectUriFor(origin: string): string {
  return `${origin}/auth/callback`
}

/** Starts a browser sign-in: generates PKCE + state, stashes the pending entry, and returns the URL to redirect the browser to. */
export async function beginLogin(oidc: ServerOidcConfig, opts: { origin: string; returnTo: string }): Promise<BeginLoginResult> {
  sweepExpiredLogins()
  const { verifier, challengeS256 } = generatePkcePair()
  const state = base64url(randomBytes(24))
  pendingLogins.set(state, { verifier, returnTo: opts.returnTo, createdAt: Date.now() })

  const doc = await discover(oidc.issuer)
  const params = new URLSearchParams({
    client_id: oidc.clientId,
    redirect_uri: redirectUriFor(opts.origin),
    response_type: 'code',
    code_challenge: challengeS256,
    code_challenge_method: 'S256',
    scope: `openid profile ${REFRESH_SCOPE_ADDITION} api://${oidc.audience}/${oidc.scope}`,
    state,
  })
  log('browser login started', { origin: opts.origin })
  return { authorizeUrl: `${doc.authorization_endpoint}?${params.toString()}`, state }
}

/**
 * Appends `client_secret` when one is configured, leaving the request
 * untouched when it is not.
 *
 * Both shapes are legitimate and a deployment picks one by how it registers
 * its redirect URI with the IdP, not by changing this code:
 *
 *  - **Public client / PKCE, no secret.** A desktop install, or an IdP that
 *    accepts a non-CORS redemption against a public-client redirect URI.
 *  - **Confidential client.** A server-side redemption against a `Web`-type
 *    redirect URI, which Entra requires a secret for. It refuses the same
 *    redemption against an SPA-type URI outright (AADSTS9002327), because an
 *    SPA URI may only be redeemed cross-origin and a server sends no `Origin`.
 *
 * One registration can carry both platforms at once, so a secret existing on
 * it never obliges a public client to send one -- which is why this is
 * conditional on the config rather than on a mode flag.
 */
function withClientSecret(body: URLSearchParams, oidc: ServerOidcConfig): URLSearchParams {
  if (oidc.clientSecret) body.set('client_secret', oidc.clientSecret)
  return body
}

export type CompleteLoginResult =
  | { ok: true; auth: Extract<AuthResult, { ok: true }>; accessToken: string; refreshToken: string | null; returnTo: string }
  | { ok: false; reason: string }

/** Exchanges an authorization code for tokens, verifies the access token, and consumes (single-use) the pending login it belongs to. */
export async function completeLogin(oidc: ServerOidcConfig, opts: { origin: string; code: string; state: string }): Promise<CompleteLoginResult> {
  sweepExpiredLogins()
  const pending = pendingLogins.get(opts.state)
  if (!pending) {
    warn('callback refused: unknown or expired state', {})
    return { ok: false, reason: 'unknown_state' }
  }
  pendingLogins.delete(opts.state)

  let doc: DiscoveryDoc
  try {
    doc = await discover(oidc.issuer)
  } catch (err) {
    warn('callback refused: discovery failed', { error: String(err) })
    return { ok: false, reason: 'discovery_failed' }
  }

  const body = withClientSecret(new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: redirectUriFor(opts.origin),
    client_id: oidc.clientId,
    code_verifier: pending.verifier,
  }), oidc)

  let tokenRes: Response
  try {
    tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    warn('callback refused: token exchange request failed', { error: String(err) })
    return { ok: false, reason: 'exchange_failed' }
  }
  if (!tokenRes.ok) {
    warn('callback refused: token endpoint returned an error', { status: tokenRes.status, body: await tokenErrorBody(tokenRes) })
    return { ok: false, reason: 'exchange_failed' }
  }

  const payload = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!payload.access_token) {
    warn('callback refused: token endpoint response has no access_token')
    return { ok: false, reason: 'exchange_failed' }
  }

  const auth = await verifyBearer({ kind: 'bearer', token: payload.access_token }, oidc)
  if (!auth.ok) {
    warn('callback refused: exchanged access token failed verification', { reason: auth.reason })
    return { ok: false, reason: auth.reason ?? 'unauthorized' }
  }

  log('browser login completed', { subject: auth.principal.subject })
  return {
    ok: true,
    auth,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    returnTo: pending.returnTo,
  }
}

export type RefreshResult =
  | { ok: true; auth: Extract<AuthResult, { ok: true }>; accessToken: string; refreshToken: string | null }
  | { ok: false }

/** Exchanges a stored refresh token for a new access token, transparent to the browser -- no client-side renewal machinery needed. */
export async function refreshAccessToken(oidc: ServerOidcConfig, refreshToken: string): Promise<RefreshResult> {
  let doc: DiscoveryDoc
  try {
    doc = await discover(oidc.issuer)
  } catch (err) {
    warn('refresh failed: discovery failed', { error: String(err) })
    return { ok: false }
  }

  // The refresh needs the secret for the same reason the exchange does: a
  // confidential client authenticates on every token-endpoint call, not just
  // the first.
  const body = withClientSecret(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: oidc.clientId,
    scope: `openid profile ${REFRESH_SCOPE_ADDITION} api://${oidc.audience}/${oidc.scope}`,
  }), oidc)

  let tokenRes: Response
  try {
    tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    warn('refresh failed: token endpoint request errored', { error: String(err) })
    return { ok: false }
  }
  if (!tokenRes.ok) {
    warn('refresh failed: token endpoint returned an error', { status: tokenRes.status, body: await tokenErrorBody(tokenRes) })
    return { ok: false }
  }

  const payload = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!payload.access_token) {
    warn('refresh failed: token endpoint response has no access_token')
    return { ok: false }
  }

  const auth = await verifyBearer({ kind: 'bearer', token: payload.access_token }, oidc)
  if (!auth.ok) {
    warn('refresh failed: refreshed access token failed verification', { reason: auth.reason })
    return { ok: false }
  }

  log('session token refreshed', { subject: auth.principal.subject })
  return {
    ok: true,
    auth,
    accessToken: payload.access_token,
    // The IdP may omit `refresh_token` on a refresh response (rotation is
    // optional); keep the caller's existing refresh token in that case.
    refreshToken: payload.refresh_token ?? refreshToken,
  }
}

export type ScopedTokenResult =
  | { ok: true; accessToken: string; expiresAt: number; refreshToken: string }
  | { ok: false; reason: string }

/**
 * Exchanges a stored refresh token for an access token for ANOTHER resource's
 * scope (`api://<app-id>/<scope>`), without disturbing the session's own
 * tokens. The caller keeps the session's refresh token unless this returns a
 * rotated one, which it must store.
 *
 * This is the refresh-token grant with a different `scope`, the form Entra
 * documents for one signed-in person reaching a second API: the new token's
 * audience is that API, not this server. Nothing is verified against this
 * server's own audience, because the token is not for this server.
 */
export async function refreshForScope(oidc: ServerOidcConfig, refreshToken: string, scope: string): Promise<ScopedTokenResult> {
  let doc: DiscoveryDoc
  try {
    doc = await discover(oidc.issuer)
  } catch (err) {
    warn('scoped refresh failed: discovery failed', { error: String(err) })
    return { ok: false, reason: 'the sign-in service could not be reached' }
  }
  const body = withClientSecret(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: oidc.clientId,
    // `openid profile` so the token carries the account claim the lookup names the person by.
    scope: `openid profile ${scope} ${REFRESH_SCOPE_ADDITION}`,
  }), oidc)

  let tokenRes: Response
  try {
    tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    warn('scoped refresh failed: token endpoint request errored', { scope, error: String(err) })
    return { ok: false, reason: 'the sign-in service could not be reached' }
  }
  if (!tokenRes.ok) {
    const detail = await tokenErrorBody(tokenRes)
    warn('scoped refresh failed: token endpoint returned an error', { scope, status: tokenRes.status, body: detail })
    return { ok: false, reason: scopedRefreshReason(detail) }
  }
  const payload = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!payload.access_token) {
    warn('scoped refresh failed: token endpoint response has no access_token', { scope })
    return { ok: false, reason: 'the sign-in service returned no token' }
  }
  log('scoped token minted', { scope })
  return {
    ok: true,
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    // The IdP may omit `refresh_token` on a refresh response; keep the caller's own then.
    refreshToken: payload.refresh_token ?? refreshToken,
  }
}

/** What a person can act on when the token endpoint refuses a scoped refresh. */
function scopedRefreshReason(detail: { error?: string; error_description?: string; error_codes?: number[] } | string): string {
  if (typeof detail === 'string') return 'the sign-in service refused the request'
  const codes = detail.error_codes ?? []
  // AADSTS65001: consent for the scope has not been granted. AADSTS70011: the scope is not valid for this app.
  if (codes.includes(65001) || detail.error === 'consent_required' || detail.error === 'interaction_required') {
    return 'this app has not been given access to the key lookup yet; an administrator must grant consent'
  }
  if (codes.includes(70011) || codes.includes(650053)) return 'this app is not set up to request the key lookup scope'
  if (detail.error === 'invalid_grant') return 'your sign-in has expired; sign in again'
  return 'the sign-in service refused the request'
}

