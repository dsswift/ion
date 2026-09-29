/**
 * `GET /auth/config` (manifest C6) — the unauthenticated probe a Studio
 * client uses to learn which credential kinds this server accepts, and to
 * fetch the nonce a `paired` credential's HMAC proof is computed over.
 *
 * Wired into `startHealth`'s route table (`http/health.ts`) rather than a
 * second `http.Server`, matching `protocol/listener.ts`'s existing pattern of
 * reusing the same TCP/local-socket listeners for the Studio WebSocket
 * upgrade.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import type { ServerOidcConfig } from '../config/server-config'
import { currentNonce } from '../auth/nonce'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-config-route', msg, fields)
}

/** Every credential kind `DefaultAuthPolicy` can resolve, regardless of whether `oidc` is configured (an unconfigured `bearer` door is still listed -- it refuses every credential, but the door exists). */
const TRANSPORTS = ['local', 'paired', 'bearer'] as const

export interface AuthConfigDeps {
  getOidc: () => ServerOidcConfig | null
  /** Read at request time: the id is minted after the route table is built (`main.ts`), and a copy taken earlier would hand every pairing a `boot-<pid>` placeholder. */
  getEnvironmentId: () => string
  label: string
  serverVersion: string
}

export interface AuthConfigBody {
  oidc: { issuer: string; audience: string; scope: string; clientId: string } | null
  transports: readonly string[]
  environmentId: string
  label: string
  protocolVersion: number
  serverVersion: string
  nonce: string
  /**
   * This server opens sealed frames on its TCP listener (`?client=<id>`).
   * A client seals only when it reads true here, so a newer client still
   * reaches a server that predates sealed TCP instead of sending it
   * envelopes it would close the socket over.
   */
  sealedTcp: true
}

/** Builds the `GET /auth/config` route handler for `http/health.ts`'s route table. */
export function authConfigRoute(deps: AuthConfigDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    const oidc = deps.getOidc()
    const body: AuthConfigBody = {
      // `clientId` (spec 18, additive to manifest C6) is the ORG client
      // registration id a browser's `oidc-client-ts` UserManager
      // authenticates as -- distinct from `audience`, which is the SERVER's
      // own app registration the resulting token must be scoped to. Reusing
      // `audience` here would make the browser request a token AS the server
      // rather than FOR the server. `server.json.oidc` has no dedicated
      // field for it yet, so it is read from the same object under a
      // `clientId` key that `parseOidc` (server-config.ts) already passes
      // through untouched as part of `ServerOidcConfig`'s open shape --
      // absent-as-empty-string when the operator has not configured a
      // browser sign-in client, which the page-level edge case ("This server
      // has no browser sign-in") already handles via `oidc === null`.
      oidc: oidc ? { issuer: oidc.issuer, audience: oidc.audience, scope: oidc.scope, clientId: oidc.clientId } : null,
      transports: TRANSPORTS,
      environmentId: deps.getEnvironmentId(),
      label: deps.label,
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: deps.serverVersion,
      nonce: currentNonce(),
      sealedTcp: true,
    }
    const payload = JSON.stringify(body)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
    res.end(payload)
    log('auth config served', { oidc_configured: oidc !== null, environment_id: body.environmentId })
  }
}
