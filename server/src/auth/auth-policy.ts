/**
 * `DefaultAuthPolicy` — the real `AuthPolicy` (manifest requirement:
 * `local` (socket only), `paired` (HMAC proof), `bearer` (`jose` jwtVerify)).
 *
 * Replaces `protocol/hello.ts`'s `LocalOnlyAuthPolicy` as `main.ts`'s default:
 * `local` still resolves through `LocalOnlyAuthPolicy` unchanged (the
 * transport-binding + `localPrincipal()` logic child 07 already wrote and
 * tested is correct and does not need a second implementation), while
 * `paired` and `bearer` -- which `LocalOnlyAuthPolicy` refuses unconditionally
 * -- resolve through `auth/paired.ts` and `auth/bearer.ts`.
 */
import type { StudioCredential } from '@ion/shared/studio-wire/types'
import { LocalOnlyAuthPolicy, type AuthPolicy, type AuthResult } from '../protocol/hello'
import type { ConnectionTransport } from '../protocol/connection'
import type { ServerOidcConfig } from '../config/server-config'
import type { CredentialsStore } from './credentials-store'
import { verifyPaired } from './paired'
import { verifyBearer } from './bearer'
import type { BrowserSessionStore } from './browser-session-store'
import { refreshAccessToken } from './browser-oidc'
import { warn as _warn, log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-policy', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-policy', msg, fields)
}

/** How long before a session's stored access-token expiry `authenticate()` proactively refreshes it -- mirrors the old client-side `REAUTH_LEAD_SECONDS` (web-auth.ts), just server-side and invisible to the browser now. */
const SESSION_REFRESH_LEAD_MS = 5 * 60_000

export interface DefaultAuthPolicyDeps {
  /** `server.json.oidc`, or null when the server fronts no OIDC issuer -- every `bearer`/`session` credential is then refused `unauthorized`. */
  oidc: ServerOidcConfig | null
  credentials: CredentialsStore
  sessions: BrowserSessionStore
}

export class DefaultAuthPolicy implements AuthPolicy {
  private readonly local = new LocalOnlyAuthPolicy()

  constructor(private readonly deps: DefaultAuthPolicyDeps) {}

  async authenticate(credential: StudioCredential, transport: ConnectionTransport, sessionCookie: string | null): Promise<AuthResult> {
    switch (credential.kind) {
      case 'local':
        return this.local.authenticate(credential, transport, sessionCookie)
      case 'paired':
        return verifyPaired(credential, this.deps.credentials)
      case 'bearer': {
        if (!this.deps.oidc) {
          warn('bearer credential presented but server.json has no oidc block; refusing', { transport })
          return { ok: false, reason: 'unauthorized' }
        }
        return verifyBearer(credential, this.deps.oidc)
      }
      case 'session':
        return this.authenticateSession(sessionCookie)
    }
  }

  /**
   * Resolves a `{kind:'session'}` credential from the cookie captured at
   * WebSocket upgrade (never from anything the client claims in the frame).
   * Refreshes the stored access token first when it's within
   * `SESSION_REFRESH_LEAD_MS` of expiry -- transparent to the browser,
   * which never sees a token or a `studio_reauth` round trip for this door.
   */
  private async authenticateSession(sessionCookie: string | null): Promise<AuthResult> {
    if (!sessionCookie) {
      warn('session credential presented with no ion_session cookie on the connection; refusing')
      return { ok: false, reason: 'unauthorized' }
    }
    if (!this.deps.oidc) {
      warn('session credential presented but server.json has no oidc block; refusing')
      return { ok: false, reason: 'unauthorized' }
    }
    const record = this.deps.sessions.get(sessionCookie)
    if (!record) {
      warn('session credential refers to an unknown or expired session; refusing')
      return { ok: false, reason: 'unauthorized' }
    }

    if (record.accessExpiresAt - Date.now() > SESSION_REFRESH_LEAD_MS) {
      this.deps.sessions.touch(sessionCookie)
      log('session accepted', { subject: record.principal.subject })
      return { ok: true, principal: record.principal, scopes: record.scopes, expiresAt: record.accessExpiresAt }
    }

    const tokens = this.deps.sessions.tokensFor(sessionCookie)
    if (!tokens?.refreshToken) {
      warn('session access token near/at expiry with no refresh token; deleting session and refusing', { subject: record.principal.subject })
      this.deps.sessions.delete(sessionCookie)
      return { ok: false, reason: 'unauthorized' }
    }

    const refreshed = await refreshAccessToken(this.deps.oidc, tokens.refreshToken)
    if (!refreshed.ok) {
      warn('session refresh failed; deleting session and refusing', { subject: record.principal.subject })
      this.deps.sessions.delete(sessionCookie)
      return { ok: false, reason: 'unauthorized' }
    }

    this.deps.sessions.updateTokens(sessionCookie, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: refreshed.auth.expiresAt ?? Date.now() + 3600_000,
    })
    log('session refreshed and accepted', { subject: refreshed.auth.principal.subject })
    return refreshed.auth
  }
}
