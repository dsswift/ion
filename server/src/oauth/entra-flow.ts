/**
 * entra-auth.ts — desktop orchestration of the ENGINE-owned Entra OIDC
 * identity.
 *
 * The engine is the authentication authority: it runs the PKCE flow's
 * loopback callback server, exchanges the authorization code, persists the
 * grant (refresh + id token, encrypted), silently refreshes, and mints
 * per-scope access tokens. The desktop's role collapses to orchestrating
 * the interactive step a headless daemon cannot perform — opening the
 * engine-generated authorization URL in the system browser — and to
 * consuming identity/token state through the engine wire:
 *
 *   sign-in   → oidc_begin_login  (engine returns the URL; its callback
 *               server completes the exchange; engine_oidc_identity
 *               broadcasts the result)
 *   identity  → oidc_identity     (snapshot query)
 *   tokens    → oidc_token        (ephemeral, scope-bound access token;
 *               the refresh token never leaves the engine)
 *   sign-out  → oidc_logout
 *
 * The previous implementation owned the token end-to-end via MSAL Node in
 * the desktop process. That inverted the layering: extensions run inside
 * the engine and headless deployments have no desktop, so a desktop-held
 * token could never serve them. MSAL is gone from this path; the legacy
 * encrypted MSAL cache file is deleted on sign-out as migration cleanup.
 *
 * Ion ships no app registration. The identity is whatever a deployment
 * writes into ~/.ion/engine.json's auth block (`entra-config.ts`), so the
 * generic engine stays free of Ion-specific identity opinions.
 */

import { openAuthUrl, type AuthUrlRequester } from './url-opener'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, unlinkSync } from 'fs'
import { engineBridge } from '../state'
import { enterprisePolicyCache } from '../enterprise-policy-publish'
import { policyMessage } from '@ion/shared/policy-failure'
import { log as _log } from '../logger'
import { getConfiguredOidcClientId } from '@ion/server/oauth/entra-auth'

export { getConfiguredOidcClientId }

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('entra_auth', msg, fields)
}

// The configuration readers (`getConfiguredTelemetryScope`,
// `ensureEntraAuthConfig`) live in entra-config.ts, which imports no engine
// bridge; they are re-exported here for the server's own callers.
export { getConfiguredTelemetryScope, ensureEntraAuthConfig } from './entra-config'
import { getConfiguredTelemetryScope } from './entra-config'

/** Legacy MSAL token-cache blob; deleted on sign-out (migration cleanup). */
const LEGACY_MSAL_CACHE_FILE = join(homedir(), '.ion', 'entra-token-cache.enc')

/** How long signIn() waits for the user to complete the browser flow.
 *  Matches the engine PKCE flow's own 5-minute timeout. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const SIGN_IN_POLL_MS = 2000

// ---------------------------------------------------------------------------
// Public identity shape
// ---------------------------------------------------------------------------

export interface EntraIdentity {
  /**
   * The primary user-attribution claim for telemetry records.
   * Preference order: preferred_username (UPN/email) → oid (object id).
   */
  user: string
  /** Raw UPN / email from id_token. May be empty for some account types. */
  username: string
  /** Display name from the id_token "name" claim. */
  displayName: string
  /** Entra object id — stable, opaque, never changes for an account. */
  oid: string
  /** The issuer that signed this identity (the id_token's iss claim). Empty from an engine that does not report it. */
  issuer: string
}

/** Wire shape of the engine's oidc_identity result payload. */
interface OidcIdentityData {
  signedIn: boolean
  requireOperatorIdentity?: boolean
  subject?: string
  issuer?: string
  username?: string
  name?: string
  provider?: string
}

function toEntraIdentity(data: OidcIdentityData): EntraIdentity {
  return {
    user: data.username || data.subject || '',
    username: data.username ?? '',
    displayName: data.name ?? '',
    oid: data.subject ?? '',
    issuer: data.issuer ?? '',
  }
}

// ---------------------------------------------------------------------------
// Exported token-manager API (engine-backed)
// ---------------------------------------------------------------------------

/**
 * Returns a valid access token for the configured telemetry scope, minted by
 * the engine (silent refresh included). The scope must be passed explicitly —
 * omitting it causes Entra to return AADSTS90009 (app requesting token for
 * itself with no resource). Returns null when not signed in, no identity
 * provider is configured, no resource scope is configured, or the engine is
 * unreachable.
 */
export async function getAccessToken(): Promise<string | null> {
  const scope = getConfiguredTelemetryScope()
  if (!scope) {
    log('entra_auth: getAccessToken: no telemetry scope configured; egress token unavailable')
    return null
  }
  const result = await engineBridge.request<{ accessToken?: string }>('oidc_token', {
    oidcScope: scope,
  })
  if (!result.ok || !result.data?.accessToken) {
    log('entra_auth: getAccessToken: engine mint unavailable', { error: result.error ?? 'no token in result' })
    return null
  }
  return result.data.accessToken
}

/**
 * Returns the signed-in identity from the engine's snapshot, or null when
 * signed out / unconfigured / engine unreachable.
 */
export interface OperatorIdentityState {
  required: boolean
  signedIn: boolean
  identity: EntraIdentity | null
}

export async function getOperatorIdentityState(): Promise<OperatorIdentityState> {
  const result = await engineBridge.request<OidcIdentityData>('oidc_identity', {})
  if (!result.ok || !result.data) {
    throw new Error(result.error ?? 'OIDC identity state unavailable')
  }
  return {
    required: result.data.requireOperatorIdentity === true,
    signedIn: result.data.signedIn === true,
    identity: result.data.signedIn ? toEntraIdentity(result.data) : null,
  }
}

export async function getSignedInIdentity(): Promise<EntraIdentity | null> {
  const result = await engineBridge.request<OidcIdentityData>('oidc_identity', {})
  if (!result.ok || !result.data?.signedIn) return null
  return toEntraIdentity(result.data)
}

/**
 * `getSignedInIdentity`, but skipped entirely (never calls `request()`, so
 * never calls `connect()`) unless `engineBridge.connected` is already true.
 *
 * `request()` connects lazily: against an engine that isn't there (a boot
 * race, no engine configured, a unit-test sandbox) that doesn't fail fast,
 * it retries with the bridge's own reconnect ladder. A caller that only
 * wants to label work with the signed-in person must never itself become a
 * new, unbounded connection attempt. `connected` is a synchronous field
 * read, never I/O, so this adds no new attempt of its own.
 */
export async function getSignedInIdentityIfEngineConnected(): Promise<EntraIdentity | null> {
  if (!engineBridge.connected) return null
  return getSignedInIdentity()
}

/**
 * Interactive sign-in. Asks the engine to begin its PKCE flow, opens the
 * returned authorization URL in the system browser, then polls the engine
 * until its loopback callback server completes the exchange (or the flow
 * times out). The desktop never sees the authorization code or any token.
 */
export async function signIn(requester?: AuthUrlRequester): Promise<{ identity: EntraIdentity; authorizationUrl: string }> {
  const begin = await engineBridge.request<{ authorizationUrl?: string }>('oidc_begin_login', {})
  if (!begin.ok || !begin.data?.authorizationUrl) {
    throw new Error(begin.error ?? 'engine did not return an authorization URL (is auth.identityProvider configured?)')
  }
  const authorizationUrl = begin.data.authorizationUrl

  log('entra_auth: opening browser for engine-owned login')
  await openAuthUrl(authorizationUrl, requester)

  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS))
    const snapshot = await engineBridge.request<OidcIdentityData>('oidc_identity', {})
    if (snapshot.ok && snapshot.data?.signedIn) {
      const identity = toEntraIdentity(snapshot.data)
      log('entra_auth: sign-in succeeded', { signed_in_user: identity.user, oid: identity.oid })
      return { identity, authorizationUrl }
    }
  }
  log('entra_auth: sign-in cancelled or timed out')
  throw new Error(policyMessage(enterprisePolicyCache.policy?.messages, 'authentication_failed', 'Entra sign-in cancelled or timed out'))
}

export interface EntraDeviceSignIn {
  userCode: string
  verificationUri: string
  /** Seconds until the code stops working. */
  expiresIn: number
}

/**
 * Device-code sign-in, for a person who is not at the host: the engine
 * returns a code to enter at the provider's page, and polls the provider
 * itself. This waits in the background, the same way `signIn` waits, until
 * the identity lands or the code expires, and logs which one happened.
 */
export async function beginDeviceSignIn(): Promise<EntraDeviceSignIn> {
  const begin = await engineBridge.request<Partial<EntraDeviceSignIn>>('oidc_begin_login', { oidcFlow: 'device' })
  const data = begin.data
  if (!begin.ok || !data?.userCode || !data.verificationUri) {
    throw new Error(begin.error ?? 'engine did not return a device code (is auth.identityProvider configured?)')
  }
  const expiresIn = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : SIGN_IN_TIMEOUT_MS / 1000
  log('entra_auth: device sign-in begun', { verification_host: safeHost(data.verificationUri), expires_in: expiresIn })
  void waitForDeviceSignIn(Date.now() + expiresIn * 1000).catch((err: unknown) => {
    log('entra_auth: device sign-in wait failed', { error: err instanceof Error ? err.message : String(err) })
  })
  return { userCode: data.userCode, verificationUri: data.verificationUri, expiresIn }
}

async function waitForDeviceSignIn(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS))
    const snapshot = await engineBridge.request<OidcIdentityData>('oidc_identity', {})
    if (snapshot.ok && snapshot.data?.signedIn) {
      const identity = toEntraIdentity(snapshot.data)
      log('entra_auth: device sign-in succeeded', { signed_in_user: identity.user, oid: identity.oid })
      return
    }
  }
  log('entra_auth: device sign-in expired before the identity landed')
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // Diagnostic only: an unparseable URL is still returned to the client as is.
    return '(unparseable)'
  }
}

/**
 * Sign the operator out: the engine deletes the persisted grant and
 * broadcasts the signed-out snapshot. Also removes the legacy MSAL cache
 * blob left behind by the previous desktop-owned implementation.
 */
export async function signOut(): Promise<void> {
  const result = await engineBridge.request('oidc_logout', {})
  if (!result.ok) {
    throw new Error(result.error ?? 'engine sign-out failed')
  }
  try {
    if (existsSync(LEGACY_MSAL_CACHE_FILE)) {
      unlinkSync(LEGACY_MSAL_CACHE_FILE)
      log('entra_auth: deleted legacy MSAL token cache file')
    }
  } catch (err) {
    log('entra_auth: legacy cache delete failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  log('entra_auth: sign-out complete')
}
