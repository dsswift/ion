/**
 * The `exchange-gitlab` git credential source: a confidential OAuth
 * application registered on the target GitLab instance (self-hosted or
 * SaaS). `gitIdentity.authorize` (`protocol/git-identity-actions.ts`) drives
 * `beginGitlabAuthorize`; `GET /auth/git/callback?provider=gitlab`
 * (`http/auth-git-callback.ts`) drives `completeGitlabAuthorize`. The
 * resulting access + refresh tokens land in `credential-store.ts` tagged
 * `exchange-gitlab`; the resolver source below refreshes the access token
 * transparently when its cached expiry has passed.
 */
import type { ServerGitExchangeGitlabConfig } from '../../../config/server-config'
import { gitCredentialStore, type GitCredentialStore } from '../credential-store'
import type { GitCredentialLookup, GitCredentialSourceProvider } from '../types'
import { OAuthCodeFlow } from './oauth-code-exchange'
import { log as _log } from '../../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-exchange-gitlab', msg, fields)
}

/** `api` covers git over HTTPS and the project-creation call (`git/hosting/providers/gitlab.ts`); GitLab has no narrower scope that can create a project. */
const SCOPE = 'api'
const flow = new OAuthCodeFlow('gitlab')

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function gitlabRedirectUri(origin: string): string {
  return `${origin}/auth/git/callback?provider=gitlab`
}

/** The host `credential-store.ts` keys this exchange's credential under -- the GitLab instance's own hostname, not the OAuth app's issuer URL. */
export function gitlabHost(cfg: ServerGitExchangeGitlabConfig): string {
  return new URL(cfg.baseUrl).host
}

export function beginGitlabAuthorize(cfg: ServerGitExchangeGitlabConfig, opts: { origin: string; subject: string }): { url: string; state: string } {
  return flow.beginAuthorize({
    authorizeUrl: `${stripTrailingSlash(cfg.baseUrl)}/oauth/authorize`,
    clientId: cfg.clientId,
    redirectUri: gitlabRedirectUri(opts.origin),
    scope: SCOPE,
    subject: opts.subject,
    host: gitlabHost(cfg),
  })
}

export type CompleteGitlabAuthorizeResult = { ok: true; subject: string; host: string } | { ok: false; reason: string }

export async function completeGitlabAuthorize(cfg: ServerGitExchangeGitlabConfig, opts: { origin: string; code: string; state: string }, store: GitCredentialStore = gitCredentialStore()): Promise<CompleteGitlabAuthorizeResult> {
  const pending = flow.consumePending(opts.state)
  if (!pending) return { ok: false, reason: 'unknown_state' }

  const tokens = await flow.exchangeCode({
    tokenUrl: `${stripTrailingSlash(cfg.baseUrl)}/oauth/token`,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: gitlabRedirectUri(opts.origin),
    code: opts.code,
  })
  if (!tokens) return { ok: false, reason: 'exchange_failed' }

  store.set({
    subject: pending.subject,
    host: pending.host,
    source: 'exchange-gitlab',
    kind: 'https-token',
    token: tokens.accessToken,
    username: 'oauth2',
    refreshToken: tokens.refreshToken ?? undefined,
  })
  accessTokenExpiryCache.set(cacheKey(pending.subject, pending.host), tokens.expiresAt)
  log('gitlab authorization completed', { subject: pending.subject, git_host: pending.host })
  return { ok: true, subject: pending.subject, host: pending.host }
}

/** In-memory access-token expiry, keyed by (subject, host) -- credential-store.ts persists the token/refresh-token, not their TTL. Lost on process restart, which just means one extra refresh call on first use, not a correctness issue. */
const accessTokenExpiryCache = new Map<string, number>()

function cacheKey(subject: string, host: string): string {
  return `${subject} ${host}`
}

/** TEST ONLY. */
export function _resetGitlabExchangeCacheForTest(): void {
  accessTokenExpiryCache.clear()
}

/** The `exchange-gitlab` source for the resolver. Refreshes the access token via the stored refresh token when the cached expiry has passed or is unknown (first use after a restart). */
export function gitlabExchangeSource(getConfig: () => ServerGitExchangeGitlabConfig | null, store: GitCredentialStore = gitCredentialStore()): GitCredentialSourceProvider {
  return {
    name: 'exchange-gitlab',
    resolve: async (subject, host): Promise<GitCredentialLookup> => {
      const cfg = getConfig()
      if (!cfg || gitlabHost(cfg) !== host) return null
      const record = store.get(subject, host)
      if (!record || record.source !== 'exchange-gitlab') return null

      const expiresAt = accessTokenExpiryCache.get(cacheKey(subject, host))
      if (expiresAt && Date.now() < expiresAt) {
        const token = store.tokenFor(subject, host)
        if (token) return { source: 'exchange-gitlab', kind: 'https-token', host, token, username: 'oauth2' }
      }

      const refreshToken = store.refreshTokenFor(subject, host)
      if (!refreshToken) return null
      const tokens = await flow.refresh({
        tokenUrl: `${stripTrailingSlash(cfg.baseUrl)}/oauth/token`,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        refreshToken,
      })
      if (!tokens) return null
      store.set({ subject, host, source: 'exchange-gitlab', kind: 'https-token', token: tokens.accessToken, username: 'oauth2', refreshToken: tokens.refreshToken ?? refreshToken })
      accessTokenExpiryCache.set(cacheKey(subject, host), tokens.expiresAt)
      return { source: 'exchange-gitlab', kind: 'https-token', host, token: tokens.accessToken, username: 'oauth2' }
    },
  }
}
