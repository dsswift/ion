/**
 * Resolves a browser session from its `ion_session` cookie: the session door
 * of the Studio wire, and the gate in front of every Fleet Hub page and
 * action. The stored access token is refreshed first when it is close to
 * expiry, so the browser never sees a token or a second sign-in.
 */
import type { AuthResult } from '../protocol/hello'
import type { ServerOidcConfig } from '../config/server-config'
import type { BrowserSessionStore } from './browser-session-store'
import { refreshAccessToken } from './browser-oidc'
import { warn as _warn, log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-session', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-session', msg, fields)
}

/** How long before a session's stored access-token expiry it is refreshed. */
const SESSION_REFRESH_LEAD_MS = 5 * 60_000

/**
 * The refresh under way for each session. A page asks for many things at
 * once, and each would otherwise spend the same refresh token: an issuer
 * that rotates them refuses the second use, which would sign the person out.
 */
const refreshing = new Map<string, Promise<AuthResult>>()

/** `sessionCookie` is the cookie captured from the request itself, never anything a client claims in a frame. */
export async function authenticateSession(oidc: ServerOidcConfig | null, sessions: BrowserSessionStore, sessionCookie: string | null): Promise<AuthResult> {
  if (!sessionCookie) {
    warn('session credential presented with no ion_session cookie on the connection; refusing')
    return { ok: false, reason: 'unauthorized' }
  }
  if (!oidc) {
    warn('session credential presented but no oidc is configured; refusing')
    return { ok: false, reason: 'unauthorized' }
  }
  const record = sessions.get(sessionCookie)
  if (!record) {
    warn('session credential refers to an unknown or expired session; refusing')
    return { ok: false, reason: 'unauthorized' }
  }

  if (record.accessExpiresAt - Date.now() > SESSION_REFRESH_LEAD_MS) {
    sessions.touch(sessionCookie)
    log('session accepted', { subject: record.principal.subject })
    return { ok: true, principal: record.principal, scopes: record.scopes, expiresAt: record.accessExpiresAt }
  }

  const underWay = refreshing.get(sessionCookie)
  if (underWay) return underWay
  const refresh = refreshSession(oidc, sessions, sessionCookie, record.principal.subject).finally(() => refreshing.delete(sessionCookie))
  refreshing.set(sessionCookie, refresh)
  return refresh
}

async function refreshSession(oidc: ServerOidcConfig, sessions: BrowserSessionStore, sessionCookie: string, subject: string): Promise<AuthResult> {
  const tokens = sessions.tokensFor(sessionCookie)
  if (!tokens?.refreshToken) {
    warn('session access token near/at expiry with no refresh token; deleting session and refusing', { subject })
    sessions.delete(sessionCookie)
    return { ok: false, reason: 'unauthorized' }
  }

  const refreshed = await refreshAccessToken(oidc, tokens.refreshToken)
  if (!refreshed.ok) {
    warn('session refresh failed; deleting session and refusing', { subject })
    sessions.delete(sessionCookie)
    return { ok: false, reason: 'unauthorized' }
  }

  sessions.updateTokens(sessionCookie, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    accessExpiresAt: refreshed.auth.expiresAt ?? Date.now() + 3600_000,
  })
  log('session refreshed and accepted', { subject: refreshed.auth.principal.subject })
  return refreshed.auth
}
