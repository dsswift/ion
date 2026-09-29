/**
 * token-source — asks the LOCAL server for a bearer token to authenticate an
 * outbound connection to a remote server (spec 12): `oidc.token{scope,
 * audience}`, which the server forwards to the engine's own `oidc_token`
 * command (see `server/src/auth/actions.ts`'s `AUTH_ACTIONS['oidc.token']`).
 *
 * Depends only on `ActionSender` (satisfied by `Broker.sendAction`) rather
 * than the Broker class itself, so this module has no import-time
 * dependency on `ws`/transport wiring and is trivial to unit test with a
 * fake sender.
 */
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-token-source', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-token-source', msg, fields)
}

export interface ActionSender {
  sendAction(environmentId: string, action: string, args: unknown[]): Promise<unknown>
}

export interface OidcTokenRequest {
  scope: string
  audience?: string
}

export interface OidcTokenResult {
  accessToken: string
  expiresAt?: number
}

function isOidcTokenResult(v: unknown): v is OidcTokenResult {
  return !!v && typeof v === 'object' && typeof (v as { accessToken?: unknown }).accessToken === 'string'
}

/**
 * Requests a fresh bearer token from the LOCAL server for use on a
 * different (remote/relay) connection. `localEnvironmentId` names the
 * already-connected local environment the request rides on.
 */
export async function requestOidcToken(
  sender: ActionSender,
  localEnvironmentId: string,
  request: OidcTokenRequest,
): Promise<OidcTokenResult> {
  const value = await sender.sendAction(localEnvironmentId, 'oidc.token', [
    { scope: request.scope, audience: request.audience },
  ])
  if (!isOidcTokenResult(value)) {
    warn('oidc.token: local server returned no accessToken', { scope: request.scope })
    throw new Error('oidc.token: local server returned no accessToken')
  }
  log('oidc.token received from local server', { scope: request.scope, expires_at: value.expiresAt })
  return value
}
