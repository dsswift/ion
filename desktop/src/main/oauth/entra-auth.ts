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
 * App-registration constants live here (the desktop is the opinionated
 * consumer) and are seeded into ~/.ion/engine.json's auth block by
 * ensureEntraAuthConfig() at startup — before the daemon starts — so the
 * generic engine stays free of Ion-specific identity opinions.
 */

import { shell } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, unlinkSync } from 'fs'
import { engineBridge } from '../state'
import { ENGINE_CONFIG_FILE, readEngineConfig } from '../settings-store'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('entra_auth', msg, fields)
}

// ---------------------------------------------------------------------------
// Identity configuration (deployment-provided, never hardcoded)
// ---------------------------------------------------------------------------
//
// The identity used for OIDC flows is CONFIGURATION, not code. Ion ships with
// no default identity: a deployment provides one by writing the auth block
// into ~/.ion/engine.json (auth.identityProvider + auth.oauth.<provider>) —
// by hand, by installer, or by an MDM-managed configuration. A fresh install
// with no configured identity simply has OIDC sign-in unavailable until
// configured. Nothing in this repository carries a real tenant, client ID,
// or hostname.

/**
 * The configured OIDC client ID for this install, read from engine.json's
 * auth block (auth.oauth.<identityProvider>.clientId). Returns '' when no
 * identity is configured. This is the value pushed to iOS as
 * relayOidcClientId so the mobile app can run its own PKCE flow against
 * the same registration.
 */
export function getConfiguredOidcClientId(): string {
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const provider = auth.identityProvider as string | undefined
    if (!provider) return ''
    const oauth = (auth.oauth ?? {}) as Record<string, unknown>
    const entry = oauth[provider] as Record<string, unknown> | undefined
    return (entry?.clientId as string) || ''
  } catch {
    return '' // silent-ok: no identity configured is a valid state; callers treat '' as unconfigured
  }
}

/**
 * The downstream telemetry scope for this install, derived from the
 * configured auth block: the first configured scope containing a '/'
 * (resource-scoped, e.g. api://<id>/Telemetry.Write). Entra requires a
 * resource-scoped scope on oidc_token or it returns AADSTS90009. Returns ''
 * when no identity or no resource scope is configured — telemetry egress
 * is then unavailable, which is the honest state.
 */
export function getConfiguredTelemetryScope(): string {
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const provider = auth.identityProvider as string | undefined
    if (!provider) return ''
    const oauth = (auth.oauth ?? {}) as Record<string, unknown>
    const entry = oauth[provider] as Record<string, unknown> | undefined
    const scopes = (entry?.scopes as string[]) || []
    return scopes.find((s) => s.includes('/') && !s.startsWith('openid')) || ''
  } catch {
    return '' // silent-ok: unconfigured identity; telemetry egress simply disabled
  }
}

/** Legacy MSAL token-cache blob; deleted on sign-out (migration cleanup). */
const LEGACY_MSAL_CACHE_FILE = join(homedir(), '.ion', 'entra-token-cache.enc')

/** How long signIn() waits for the user to complete the browser flow.
 *  Matches the engine PKCE flow's own 5-minute timeout. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const SIGN_IN_POLL_MS = 2000

// ---------------------------------------------------------------------------
// Identity configuration check (startup observability)
// ---------------------------------------------------------------------------

/**
 * Log the identity-configuration state at startup so an unconfigured install
 * is diagnosable from the log file alone. Identity lives in engine.json's
 * auth block (auth.identityProvider + auth.oauth.<provider>); deployments
 * write it by hand, by installer, or by MDM-managed configuration. This
 * function never writes anything. Returns true when an identity is configured.
 */
export function ensureEntraAuthConfig(): boolean {
  if (!existsSync(ENGINE_CONFIG_FILE)) return false
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const provider = auth.identityProvider as string | undefined
    if (provider) {
      log('entra_auth: identity configured', { provider })
      return true
    }
    log('entra_auth: no identity configured; OIDC sign-in unavailable until auth block is written to engine.json')
    return false
  } catch (err) {
    log('entra_auth: identity config check failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

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
}

/** Wire shape of the engine's oidc_identity result payload. */
interface OidcIdentityData {
  signedIn: boolean
  requireOperatorIdentity?: boolean
  subject?: string
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
 * Interactive sign-in. Asks the engine to begin its PKCE flow, opens the
 * returned authorization URL in the system browser, then polls the engine
 * until its loopback callback server completes the exchange (or the flow
 * times out). The desktop never sees the authorization code or any token.
 */
export async function signIn(): Promise<EntraIdentity> {
  const begin = await engineBridge.request<{ authorizationUrl?: string }>('oidc_begin_login', {})
  if (!begin.ok || !begin.data?.authorizationUrl) {
    throw new Error(begin.error ?? 'engine did not return an authorization URL (is auth.identityProvider configured?)')
  }

  log('entra_auth: opening browser for engine-owned login')
  await shell.openExternal(begin.data.authorizationUrl)

  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS))
    const snapshot = await engineBridge.request<OidcIdentityData>('oidc_identity', {})
    if (snapshot.ok && snapshot.data?.signedIn) {
      const identity = toEntraIdentity(snapshot.data)
      log('entra_auth: sign-in succeeded', { user: identity.user, oid: identity.oid })
      return identity
    }
  }
  throw new Error('Entra sign-in cancelled or timed out')
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
