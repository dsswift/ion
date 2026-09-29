/**
 * `POST /auth/pair` — pairing-link completion over LAN (manifest requirement:
 * "Pairing completion (over LAN, or over a relay pairing channel): DH per
 * pairing.ts"). A relay-channel completion runs the same
 * `auth/pairing-links.ts#completePairing` call, fed by the pairing channel's
 * forwarded messages instead of an HTTP POST -- this route is the LAN path,
 * reusing the same completion function so there is exactly one place a
 * pairing link turns into a `credentials.json` client record.
 *
 * An `Authorization: Bearer` header names the person the device belongs to
 * (`auth/pairing-bearer.ts`). It is checked before the one-time code is
 * spent, so a refused token leaves the link usable for a second attempt.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { completePairing } from '../auth/pairing-links'
import { bearerFromAuthorization, resolvePairingBearer } from '../auth/pairing-bearer'
import type { ServerOidcConfig } from '../config/server-config'
import { advertisedRelays } from '../auth/relay-advertise'
import { currentServerConfig } from '../config/current'
import type { CredentialsStore, CredentialClientKind } from '../auth/credentials-store'
import { isRelayIdentity } from '@ion/shared/studio-wire/relay-envelope'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-pair-route', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-pair-route', msg, fields)
}

const MAX_BODY_BYTES = 8192

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds the 8KB cap'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Builds the `POST /auth/pair` route handler for `http/health.ts`'s route
 * table. `getOidc` reads the identity provider an accompanying bearer is
 * verified against; it defaults to the live `server.json`.
 */
export function authPairRoute(
  store: CredentialsStore,
  getOidc: () => ServerOidcConfig | null = () => currentServerConfig().oidc,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    const bearer = bearerFromAuthorization(req.headers.authorization)
    readBody(req)
      .then(async (raw) => {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch (err) {
          warn('pairing completion refused: request body is not valid JSON', { error: String(err) })
          writeJson(res, 400, { error: 'invalid_json' })
          return
        }

        const code = typeof body.code === 'string' ? body.code : ''
        const peerPublicKey = typeof body.peerPublicKey === 'string' ? body.peerPublicKey : ''
        const label = typeof body.label === 'string' ? body.label : ''
        const kind: CredentialClientKind = body.kind === 'mobile' ? 'mobile' : 'desktop'
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId : undefined
        const relayIdentity = isRelayIdentity(body.relayIdentity) ? body.relayIdentity : undefined
        if (!code || !peerPublicKey) {
          warn('pairing completion refused: missing code or peerPublicKey')
          writeJson(res, 400, { error: 'missing_fields' })
          return
        }

        const signedIn = await resolvePairingBearer(bearer, getOidc())
        if (!signedIn.ok) {
          writeJson(res, 401, { error: signedIn.reason })
          return
        }

        const result = completePairing(store, { code, peerPublicKey, label, kind, deviceId, relayIdentity, accompanyingSubject: signedIn.subject })
        if (!result.ok) {
          log('pairing completion refused', { reason: result.reason })
          writeJson(res, 410, { error: result.reason })
          return
        }

        const relays = advertisedRelays(currentServerConfig())
        log('pairing completed via /auth/pair', { client_id: result.clientId, kind, relay_count: relays.length, signed_in: signedIn.subject !== undefined })
        writeJson(res, 200, { clientId: result.clientId, ourPublicKey: result.ourPublicKey, scopes: result.scopes, relays })
      })
      .catch((err: unknown) => {
        warn('pairing completion refused: request body read failed', { error: String(err) })
        writeJson(res, 400, { error: 'bad_request' })
      })
  }
}
