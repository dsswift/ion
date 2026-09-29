/**
 * server-bearer -- the access token a Sign in (bearer) environment is
 * reached with, minted by that server's own sign-in app.
 *
 * The person signs in once, in the browser. The refresh token is stored
 * encrypted under the environment (`credentials.ts`) and redeemed on every
 * later connect, so the browser only opens again when the refresh token is
 * refused (expired, revoked, or the person was unassigned).
 *
 * Reconnects run on a backoff loop, so an interactive sign-in is
 * single-flight per environment, and one that fails or is abandoned holds
 * the next for `INTERACTIVE_COOLDOWN_MS` instead of opening a tab per retry.
 */
import { shell } from 'electron'
import type { BearerEnvironmentTarget } from '@ion/shared/types-environments'
import { loadCredential, saveCredential } from './credentials'
import { refreshServerToken, signInKeepingRefresh, type ServerSignInDeps } from './server-sign-in'
import type { ServerSignIn } from './pairing'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('server-bearer', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-bearer', msg, fields)
}

const INTERACTIVE_COOLDOWN_MS = 2 * 60 * 1000

interface StoredBearer {
  refreshToken: string
}

const inFlight = new Map<string, Promise<string>>()
const failedAt = new Map<string, number>()

function readStored(environmentId: string): StoredBearer | null {
  const stored = loadCredential(environmentId)
  if (!stored || stored.kind !== 'bearer') return null
  try {
    const parsed = JSON.parse(stored.plaintext) as Partial<StoredBearer>
    return typeof parsed.refreshToken === 'string' && parsed.refreshToken ? { refreshToken: parsed.refreshToken } : null
  } catch {
    // silent-ok: an older build stored a bare access token here; it is expired by now and a sign-in replaces it
    return null
  }
}

function store(environmentId: string, refreshToken: string | undefined): void {
  if (!refreshToken) {
    warn('sign-in returned no refresh token; the next connect signs in again', { environment_id: environmentId })
    return
  }
  saveCredential(environmentId, 'bearer', JSON.stringify({ refreshToken } satisfies StoredBearer))
}

async function mint(environmentId: string, server: ServerSignIn, deps: ServerSignInDeps): Promise<string> {
  const stored = readStored(environmentId)
  if (stored) {
    try {
      const tokens = await refreshServerToken(server, stored.refreshToken, deps)
      store(environmentId, tokens.refreshToken)
      return tokens.accessToken
    } catch (err) {
      warn('stored refresh token refused; signing in again', { environment_id: environmentId, error: String(err) })
    }
  }
  const last = failedAt.get(environmentId)
  if (last !== undefined && Date.now() - last < INTERACTIVE_COOLDOWN_MS) {
    throw new Error('Sign-in for this server did not finish. Reconnect from Settings to try again.')
  }
  log('signing in to the server', { environment_id: environmentId, issuer: server.issuer })
  try {
    const tokens = await signInKeepingRefresh(server, deps)
    failedAt.delete(environmentId)
    store(environmentId, tokens.refreshToken)
    return tokens.accessToken
  } catch (err) {
    failedAt.set(environmentId, Date.now())
    throw err
  }
}

/** An access token for the bearer environment `environmentId`. Throws with a readable reason when none can be had. */
export function bearerTokenFor(
  environmentId: string,
  oidc: NonNullable<BearerEnvironmentTarget['oidc']>,
  deps: ServerSignInDeps = { openUrl: (url) => shell.openExternal(url) },
): Promise<string> {
  const running = inFlight.get(environmentId)
  if (running) return running
  const server: ServerSignIn = { issuer: oidc.issuer, audience: oidc.audience, scope: oidc.scope, clientId: oidc.clientId ?? '' }
  const pending = mint(environmentId, server, deps).finally(() => inFlight.delete(environmentId))
  inFlight.set(environmentId, pending)
  return pending
}

/** A user-initiated reconnect clears the cooldown so the browser may open again. */
export function clearBearerSignInCooldown(environmentId: string): void {
  failedAt.delete(environmentId)
}
