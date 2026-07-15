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
import { ENGINE_CONFIG_FILE, readEngineConfig, writeEngineConfig } from '../settings-store'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('entra_auth', msg, fields)
}

// ---------------------------------------------------------------------------
// App registration constants (operator-provisioned, public client, Ion)
// ---------------------------------------------------------------------------

const ENTRA_CLIENT_ID = '2539daa2-51e3-47e0-975c-7297283f82cf'
const ENTRA_TENANT_ID = '5698dde5-3af7-4060-8ecb-e8da8747fb4a'
const ENTRA_AUTHORITY = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`

/** The downstream API scope used when minting tokens for egress endpoints
 *  (e.g. ion-telemetry.sprague.house). This is the resource-scoped scope
 *  the engine passes to Entra when calling oidc_token; must be specified
 *  explicitly or Entra returns AADSTS90009 (app requesting token for itself). */
export const ENTRA_TELEMETRY_SCOPE = `api://${ENTRA_CLIENT_ID}/Telemetry.Write`

const ENTRA_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  ENTRA_TELEMETRY_SCOPE,
]

/** Legacy MSAL token-cache blob; deleted on sign-out (migration cleanup). */
const LEGACY_MSAL_CACHE_FILE = join(homedir(), '.ion', 'entra-token-cache.enc')

/** How long signIn() waits for the user to complete the browser flow.
 *  Matches the engine PKCE flow's own 5-minute timeout. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const SIGN_IN_POLL_MS = 2000

// ---------------------------------------------------------------------------
// Engine auth-config seeding
// ---------------------------------------------------------------------------

/**
 * Seed the Ion Entra app registration into ~/.ion/engine.json's auth block
 * when absent, making the engine the identity authority for this install.
 * Call at startup BEFORE ensureEngineDaemon() (alongside
 * claimEngineEgressForDesktop) so a fresh daemon reads it on first start.
 *
 * Idempotent: never overwrites an existing auth.oauth.entra entry or an
 * existing identityProvider choice — an operator or enterprise that
 * configured a different identity keeps it. Returns true when it wrote.
 */
export function ensureEntraAuthConfig(): boolean {
  if (!existsSync(ENGINE_CONFIG_FILE)) return false
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const oauth = (auth.oauth ?? {}) as Record<string, unknown>
    if (auth.identityProvider || oauth.entra) return false // operator/enterprise decided

    oauth.entra = {
      clientId: ENTRA_CLIENT_ID,
      authorizationUrl: `${ENTRA_AUTHORITY}/oauth2/v2.0/authorize`,
      tokenUrl: `${ENTRA_AUTHORITY}/oauth2/v2.0/token`,
      deviceAuthorizationUrl: `${ENTRA_AUTHORITY}/oauth2/v2.0/devicecode`,
      scopes: ENTRA_SCOPES,
      usePkce: true,
      // Entra matches public-client loopback redirects on the literal
      // "localhost" spelling (host+path, port ignored). The app
      // registration allows http://localhost/callback.
      redirectUri: 'http://localhost/callback',
    }
    auth.oauth = oauth
    auth.identityProvider = 'entra'
    cfg.auth = auth
    writeEngineConfig(cfg)
    log('entra_auth: seeded engine auth config (identityProvider=entra)')
    return true
  } catch (err) {
    log('entra_auth: auth config seed failed (non-fatal)', {
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
 * Returns a valid access token for the Telemetry.Write scope, minted by the
 * engine (silent refresh included). The scope must be passed explicitly —
 * omitting it causes Entra to return AADSTS90009 (app requesting token for
 * itself with no resource). Returns null when not signed in, no identity
 * provider is configured, or the engine is unreachable.
 */
export async function getAccessToken(): Promise<string | null> {
  const result = await engineBridge.request<{ accessToken?: string }>('oidc_token', {
    oidcScope: ENTRA_TELEMETRY_SCOPE,
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
