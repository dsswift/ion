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
import { authenticateSession } from './session-auth'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-policy', msg, fields)
}

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
        return authenticateSession(this.deps.oidc, this.deps.sessions, sessionCookie)
    }
  }
}
