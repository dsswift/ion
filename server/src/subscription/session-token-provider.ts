/**
 * Mints the access token the subscription lookup is called with, for one
 * person, from the refresh token their browser session already holds.
 *
 * It is the same source the Azure DevOps exchange uses (`exchange-ado.ts`):
 * the most recent browser session for the subject. A person who has never
 * signed in through a browser has none, and the lookup says so plainly
 * instead of guessing.
 *
 * The scope names ANOTHER API (`api://<app-id>/Gateway.Keys.Read`), so the
 * token's audience is that API and not this server. The session's own tokens
 * are not touched, except to keep a rotated refresh token.
 */
import type { ServerOidcConfig } from '../config/server-config'
import type { ServerSubscriptionLookupConfig } from '../config/subscription-lookup-config'
import { browserSessionStore, type BrowserSessionStore } from '../auth/browser-session-store'
import { refreshForScope } from '../auth/browser-oidc'
import type { TokenProvider } from './subscription-state'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subscription-token', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('subscription-token', msg, fields)
}

/** A token is reused until it is this close to expiring. */
const EXPIRY_MARGIN_MS = 60_000

export function sessionTokenProvider(
  getOidc: () => ServerOidcConfig | null,
  getLookup: () => ServerSubscriptionLookupConfig | null,
  sessions: BrowserSessionStore = browserSessionStore(),
): TokenProvider {
  const cache = new Map<string, { accessToken: string; expiresAt: number; scope: string }>()
  return async (subject) => {
    const oidc = getOidc()
    const lookup = getLookup()
    if (!oidc) return { ok: false, reason: 'this server has no sign-in configured' }
    if (!lookup) return { ok: false, reason: 'no subscription lookup is configured' }

    const cached = cache.get(subject)
    if (cached && cached.scope === lookup.scope && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
      return { ok: true, accessToken: cached.accessToken }
    }

    const session = sessions.mostRecentSessionFor(subject)
    if (!session) {
      warn('no browser session for this person', { subject })
      return { ok: false, reason: 'you have not signed in to this server in a browser' }
    }
    const tokens = sessions.tokensFor(session.sessionId)
    if (!tokens?.refreshToken) {
      warn('browser session has no refresh token', { subject })
      return { ok: false, reason: 'your sign-in cannot be renewed; sign in again' }
    }

    const minted = await refreshForScope(oidc, tokens.refreshToken, lookup.scope)
    if (!minted.ok) return { ok: false, reason: minted.reason }
    if (minted.refreshToken !== tokens.refreshToken) {
      // The IdP rotated the refresh token. Keep the session's own access token as it was.
      sessions.updateTokens(session.sessionId, {
        accessToken: tokens.accessToken,
        refreshToken: minted.refreshToken,
        accessExpiresAt: session.accessExpiresAt,
      })
    }
    cache.set(subject, { accessToken: minted.accessToken, expiresAt: minted.expiresAt, scope: lookup.scope })
    log('lookup token minted', { subject, scope: lookup.scope })
    return { ok: true, accessToken: minted.accessToken }
  }
}
