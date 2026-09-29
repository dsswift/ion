/**
 * The `exchange-github` git credential source: a GitHub App's
 * user-to-server OAuth flow. `gitIdentity.authorize`
 * (`protocol/git-identity-actions.ts`) drives `beginGithubAuthorize`;
 * `GET /auth/git/callback?provider=github` (`http/auth-git-callback.ts`)
 * drives `completeGithubAuthorize`. Scoped to `github.com` -- GitHub
 * Enterprise Server support would need a configurable host, out of scope
 * here (see `docs/deployment/git-identity-setup.md`).
 */
import type { ServerGitExchangeGithubConfig } from '../../../config/server-config'
import { gitCredentialStore, type GitCredentialStore } from '../credential-store'
import type { GitCredentialLookup, GitCredentialSourceProvider } from '../types'
import { OAuthCodeFlow } from './oauth-code-exchange'
import { log as _log } from '../../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-exchange-github', msg, fields)
}

export const GITHUB_HOST = 'github.com'
const flow = new OAuthCodeFlow('github')

export function githubRedirectUri(origin: string): string {
  return `${origin}/auth/git/callback?provider=github`
}

export function beginGithubAuthorize(cfg: ServerGitExchangeGithubConfig, opts: { origin: string; subject: string }): { url: string; state: string } {
  return flow.beginAuthorize({
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    clientId: cfg.clientId,
    redirectUri: githubRedirectUri(opts.origin),
    // GitHub App user-to-server tokens carry the App's installation
    // permissions, not an OAuth `scope` -- an empty scope is the documented
    // shape for this flow.
    scope: '',
    subject: opts.subject,
    host: GITHUB_HOST,
  })
}

export type CompleteGithubAuthorizeResult = { ok: true; subject: string; host: string } | { ok: false; reason: string }

export async function completeGithubAuthorize(cfg: ServerGitExchangeGithubConfig, opts: { origin: string; code: string; state: string }, store: GitCredentialStore = gitCredentialStore()): Promise<CompleteGithubAuthorizeResult> {
  const pending = flow.consumePending(opts.state)
  if (!pending) return { ok: false, reason: 'unknown_state' }

  const tokens = await flow.exchangeCode({
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: githubRedirectUri(opts.origin),
    code: opts.code,
  })
  if (!tokens) return { ok: false, reason: 'exchange_failed' }

  // GitHub presents its user-to-server token as the password with any
  // non-empty username; 'x-access-token' matches GitHub's own documented
  // convention for app-installation tokens.
  store.set({
    subject: pending.subject,
    host: pending.host,
    source: 'exchange-github',
    kind: 'https-token',
    token: tokens.accessToken,
    username: 'x-access-token',
    refreshToken: tokens.refreshToken ?? undefined,
  })
  accessTokenExpiryCache.set(pending.subject, tokens.expiresAt)
  log('github authorization completed', { subject: pending.subject })
  return { ok: true, subject: pending.subject, host: pending.host }
}

/** In-memory access-token expiry, keyed by subject (GitHub App tokens are always for github.com). Lost on restart -- one extra refresh call, not a correctness issue. */
const accessTokenExpiryCache = new Map<string, number>()

/** TEST ONLY. */
export function _resetGithubExchangeCacheForTest(): void {
  accessTokenExpiryCache.clear()
}

/** The `exchange-github` source for the resolver. Refreshes the access token via the stored refresh token when the cached expiry has passed or is unknown. */
export function githubExchangeSource(getConfig: () => ServerGitExchangeGithubConfig | null, store: GitCredentialStore = gitCredentialStore()): GitCredentialSourceProvider {
  return {
    name: 'exchange-github',
    resolve: async (subject, host): Promise<GitCredentialLookup> => {
      const cfg = getConfig()
      if (!cfg || host !== GITHUB_HOST) return null
      const record = store.get(subject, host)
      if (!record || record.source !== 'exchange-github') return null

      const expiresAt = accessTokenExpiryCache.get(subject)
      if (expiresAt && Date.now() < expiresAt) {
        const token = store.tokenFor(subject, host)
        if (token) return { source: 'exchange-github', kind: 'https-token', host, token, username: 'x-access-token' }
      }

      const refreshToken = store.refreshTokenFor(subject, host)
      if (!refreshToken) return null
      const tokens = await flow.refresh({
        tokenUrl: 'https://github.com/login/oauth/access_token',
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        refreshToken,
      })
      if (!tokens) return null
      store.set({ subject, host, source: 'exchange-github', kind: 'https-token', token: tokens.accessToken, username: 'x-access-token', refreshToken: tokens.refreshToken ?? refreshToken })
      accessTokenExpiryCache.set(subject, tokens.expiresAt)
      return { source: 'exchange-github', kind: 'https-token', host, token: tokens.accessToken, username: 'x-access-token' }
    },
  }
}
