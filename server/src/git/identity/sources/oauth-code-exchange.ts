/**
 * Shared confidential-client authorization-code OAuth flow: GitLab and
 * GitHub's exchanges (`exchange-gitlab.ts`, `exchange-github.ts`) are the
 * same shape -- authorize redirect, code-for-tokens exchange, refresh-token
 * renewal -- differing only in their endpoints and scope string, so the
 * mechanics live here once. Distinct from `auth/browser-oidc.ts`'s PKCE flow
 * (a public SPA client signing a person into Studio itself): this is a
 * confidential client (client secret, no PKCE) authorizing THIS SERVER to
 * push/pull git on a person's behalf against a third-party host.
 */
import { randomBytes } from 'crypto'
import { log as _log, warn as _warn } from '../../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-oauth-exchange', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('git-identity-oauth-exchange', msg, fields)
}

const PENDING_TTL_MS = 10 * 60_000

interface PendingAuthorize {
  subject: string
  host: string
  createdAt: number
}

export interface OAuthTokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
}

async function errorBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch (err) {
    return `<unreadable body: ${String(err)}>`
  }
}

/** One provider's pending-authorize state and token exchange, keyed by its own `name` so GitLab and GitHub states never collide even if a `state` value happened to match. */
export class OAuthCodeFlow {
  private readonly pending = new Map<string, PendingAuthorize>()

  constructor(private readonly name: string) {}

  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state)
    }
  }

  /** Starts an authorize redirect for `subject`/`host` and stashes the pending state. */
  beginAuthorize(opts: { authorizeUrl: string; clientId: string; redirectUri: string; scope: string; subject: string; host: string }): { url: string; state: string } {
    this.sweep()
    const state = randomBytes(24).toString('base64url')
    this.pending.set(state, { subject: opts.subject, host: opts.host, createdAt: Date.now() })
    const params = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: opts.scope,
      state,
    })
    log('authorize started', { provider: this.name, git_host: opts.host })
    return { url: `${opts.authorizeUrl}?${params.toString()}`, state }
  }

  /** Consumes (single-use) the pending entry for `state`, or null when unknown/expired. */
  consumePending(state: string): PendingAuthorize | null {
    this.sweep()
    const entry = this.pending.get(state)
    if (!entry) return null
    this.pending.delete(state)
    return entry
  }

  /** Exchanges an authorization code for tokens. */
  async exchangeCode(opts: { tokenUrl: string; clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<OAuthTokenResponse | null> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    })
    return this.postToken(opts.tokenUrl, body)
  }

  /** Exchanges a stored refresh token for a fresh access token. */
  async refresh(opts: { tokenUrl: string; clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthTokenResponse | null> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    })
    return this.postToken(opts.tokenUrl, body)
  }

  private async postToken(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokenResponse | null> {
    let res: Response
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      warn('token request failed', { provider: this.name, error: String(err) })
      return null
    }
    if (!res.ok) {
      warn('token endpoint returned an error', { provider: this.name, status: res.status, body: await errorBody(res) })
      return null
    }
    const payload = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!payload.access_token) {
      warn('token endpoint response has no access_token', { provider: this.name })
      return null
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    }
  }
}
