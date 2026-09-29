/**
 * transport-relay -- a Studio wire connection through a relay server,
 * sealed end to end with the pairing's shared secret (spec 12, ADR-033).
 *
 * The desktop joins the relay channel `deriveChannelId(secret)` in the
 * `mobile` role (the relay's name for the joining side; the server holds
 * the `ion` role on the same channel, see `server/src/protocol/relay-
 * listener.ts`), authenticating to the relay with the PSK or OIDC token the
 * server advertised at pairing time. Every frame either way is an
 * AES-256-GCM envelope (`@ion/shared/studio-wire/relay-envelope`); the
 * relay never sees a key or a plaintext frame.
 *
 * `RelayStudioSocket` presents the small WebSocket surface the broker
 * drives (`open`/`message`/`close`/`error`, `send`, `close`, `readyState`),
 * so the broker's hello, reconnect ladder, and phase reporting are exactly
 * the TCP ones with transport `relay`.
 */
import WebSocket from 'ws'
import { deriveChannelId } from '@ion/shared/e2e'
import { SealedStudioSocket } from './sealed-studio-socket'
import type { EnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-transport-relay', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-transport-relay', msg, fields)
}

/** Derives the relay channel id from the pairing's shared secret. */
export function relayChannelId(sharedSecret: Buffer): string {
  return deriveChannelId(sharedSecret)
}

/** The relay's channel endpoint for the joining side. */
export function relayJoinUrl(relayUrl: string, channelId: string): string {
  let base = relayUrl.replace(/\/$/, '')
  base = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
  return `${base}/v1/channel/${channelId}?role=mobile`
}

export type { StudioSocketLike } from './sealed-studio-socket'

/**
 * A relay channel wearing the broker's socket surface: a `SealedStudioSocket`
 * over the relay's WebSocket. The sealing is `sealed-studio-socket.ts`,
 * shared with sealed TCP; what is relay-specific is the join URL, the
 * bearer, the rejected-upgrade report, and skipping the relay's own
 * plaintext `relay:*` control frames.
 */
export class RelayStudioSocket extends SealedStudioSocket {
  constructor(readonly relayUrl: string, channelId: string, sharedSecret: Buffer, bearer: string) {
    const url = relayJoinUrl(relayUrl, channelId)
    log('joining relay channel', { relay_url: relayUrl, channel_id: channelId.slice(0, 8) })
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` } })
    super(ws, sharedSecret, { label: relayUrl, skipRelayControlFrames: true })
    ws.on('unexpected-response', (_req, res) => {
      warn('relay upgrade rejected', { relay_url: relayUrl, http_status: res.statusCode })
      res.resume()
      this.emit('error', new Error(`relay ${relayUrl} refused the channel join: HTTP ${res.statusCode}`))
    })
  }
}

/** Opens a sealed Studio connection to `relay`'s channel for this pairing. `bearer` is the PSK or a minted OIDC token. */
export function connectRelayStudio(relay: EnvironmentRelay, sharedSecret: Buffer, bearer: string): RelayStudioSocket {
  return new RelayStudioSocket(relay.url, relayChannelId(sharedSecret), sharedSecret, bearer)
}
