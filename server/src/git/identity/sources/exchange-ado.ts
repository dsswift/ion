/**
 * The `exchange-ado` git credential source: Azure DevOps via Entra
 * on-behalf-of, using the SAME Entra app registration and session tokens a
 * browser Studio client already holds (`auth/browser-session-store.ts`) --
 * no separate authorize/callback step, unlike GitLab/GitHub. This is the one
 * exchange source with an architectural limitation worth stating plainly:
 * OBO needs a live user access token as its assertion, and today the only
 * place that token is durably held is a BROWSER session (a bearer-only
 * desktop/CLI connection presents its token per-request and the server
 * keeps no copy). So this source resolves only for a subject with at least
 * one browser Studio session open somewhere; a subject who has only ever
 * connected via bearer auth falls through to `user`, same as if ADO
 * exchange were disabled entirely.
 */
import type { ServerOidcConfig } from '../../../config/server-config'
import { browserSessionStore, type BrowserSessionStore } from '../../../auth/browser-session-store'
import { refreshAccessToken } from '../../../auth/browser-oidc'
import type { GitCredentialLookup, GitCredentialSourceProvider } from '../types'
import { log as _log, warn as _warn } from '../../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-exchange-ado', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('git-identity-exchange-ado', msg, fields)
}

/** Azure DevOps's fixed resource (App ID) for on-behalf-of token requests -- the same GUID for every Entra tenant, documented by Microsoft. */
const ADO_RESOURCE_APP_ID = '499b84ac-1321-427f-aa17-267ca6975798'

export const ADO_HOSTS = ['dev.azure.com']

export function isAdoHost(host: string): boolean {
  return ADO_HOSTS.includes(host) || host.endsWith('.visualstudio.com')
}

function tokenEndpointFor(issuer: string): string {
  // `issuer` is `https://login.microsoftonline.com/<tenant>/v2.0` (or the
  // tenant-agnostic `/common/`/`/organizations/` variants) -- the v2 token
  // endpoint replaces the trailing `/v2.0` with `/oauth2/v2.0/token`.
  return `${issuer.replace(/\/v2\.0\/?$/, '')}/oauth2/v2.0/token`
}

/** The server's own confidential-client identifier for the OBO assertion -- `audience` doubles as this app's identifier (already used to verify the `aud` claim on every bearer request), stripped of an `api://` App-ID-URI prefix if present. */
function serverClientId(oidc: ServerOidcConfig): string {
  return oidc.audience.replace(/^api:\/\//, '')
}

export interface AdoObo {
  accessToken: string
  expiresAt: number
}

/** Performs the Entra on-behalf-of exchange: the caller's own access token in, an Azure DevOps-scoped access token out. */
export async function exchangeUserTokenForAdoToken(oidc: ServerOidcConfig, userAccessToken: string): Promise<AdoObo | null> {
  if (!oidc.clientSecret) {
    warn('OBO refused: server.json.oidc.clientSecretRef is not configured')
    return null
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: serverClientId(oidc),
    client_secret: oidc.clientSecret,
    assertion: userAccessToken,
    scope: `${ADO_RESOURCE_APP_ID}/.default`,
    requested_token_use: 'on_behalf_of',
  })
  let res: Response
  try {
    res = await fetch(tokenEndpointFor(oidc.issuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    warn('OBO request failed', { error: String(err) })
    return null
  }
  if (!res.ok) {
    warn('OBO token endpoint returned an error', { status: res.status, body: await res.text().catch(() => '<unreadable>') })
    return null
  }
  const payload = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!payload.access_token) {
    warn('OBO response has no access_token')
    return null
  }
  return { accessToken: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 }
}

/** In-memory OBO access-token cache, keyed by subject -- ADO OBO tokens are short-lived and re-derivable from the browser session at any time, so nothing here needs to survive a restart. */
const oboCache = new Map<string, AdoObo>()

/** TEST ONLY. */
export function _resetAdoExchangeCacheForTest(): void {
  oboCache.clear()
}

/** The `exchange-ado` source for the resolver. */
export function adoExchangeSource(getOidc: () => ServerOidcConfig | null, getEnabled: () => boolean, sessions: BrowserSessionStore = browserSessionStore()): GitCredentialSourceProvider {
  return {
    name: 'exchange-ado',
    resolve: async (subject, host): Promise<GitCredentialLookup> => {
      if (!isAdoHost(host) || !getEnabled()) return null
      const oidc = getOidc()
      if (!oidc) return null

      const cached = oboCache.get(subject)
      if (cached && Date.now() < cached.expiresAt) {
        return { source: 'exchange-ado', kind: 'https-token', host, token: cached.accessToken, username: 'oauth2' }
      }

      const session = sessions.mostRecentSessionFor(subject)
      if (!session) return null
      let tokens = sessions.tokensFor(session.sessionId)
      if (!tokens) return null

      if (Date.now() >= session.accessExpiresAt) {
        if (!tokens.refreshToken) return null
        const refreshed = await refreshAccessToken(oidc, tokens.refreshToken)
        if (!refreshed.ok) return null
        sessions.updateTokens(session.sessionId, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          accessExpiresAt: refreshed.auth.expiresAt ?? Date.now() + 3600_000,
        })
        tokens = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken }
      }

      const obo = await exchangeUserTokenForAdoToken(oidc, tokens.accessToken)
      if (!obo) return null
      oboCache.set(subject, obo)
      log('ado obo token minted', { subject, git_host: host })
      return { source: 'exchange-ado', kind: 'https-token', host, token: obo.accessToken, username: 'oauth2' }
    },
  }
}
