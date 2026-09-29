/**
 * Boots one persistent `RelayClient` per `server.json.relays[]` entry
 * (manifest requirement: "for each `relays[]` entry connect as `role=ion`
 * with the PSK, send `relay_announce{issuer,audience,scope}` from
 * `server.json.oidc` ... reconnect with the existing ladder").
 *
 * Each client joins the relay channel keyed by this server's own
 * `environmentId` -- the stable id a remote Studio client (browser, second
 * desktop, future mobile bridge) already has from `GET /auth/config` and uses
 * to find this server on the relay as `role=mobile`. This is distinct from
 * `auth/pairing-channels.ts`'s one-time `'pairing:'+hex` channels, which
 * exist only to complete a NEW pairing, not to carry the server's ongoing
 * Studio-wire traffic.
 */
import { RelayClient, type RelayAnnounceTrust } from './relay-client'
import type { ServerConfig } from '../config/server-config'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay-clients-boot', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('relay-clients-boot', msg, fields)
}

export interface RelayClientsHandle {
  clients: RelayClient[]
  close(): void
}

/** Starts (and connects) one `RelayClient` per configured relay. Skips any entry whose PSK could not be resolved. */
export function startRelayClients(config: ServerConfig, environmentId: string): RelayClientsHandle {
  const announceTrust: RelayAnnounceTrust | undefined = config.oidc
    ? { issuer: config.oidc.issuer, audience: config.oidc.audience, scope: config.oidc.scope }
    : undefined

  const clients: RelayClient[] = []
  for (const relay of config.relays) {
    if (relay.oidc) {
      // This channel joins with a pre-shared key. A relay the server signs
      // in to with OIDC carries the per-device Studio channels instead
      // (`protocol/relay-listener.ts`).
      log('relay not used for the environment channel: it authenticates with OIDC', { relay_url: relay.url })
      continue
    }
    if (!relay.psk) {
      warn('relay skipped: psk could not be resolved (secretstore reference unresolved)', { relay_url: relay.url })
      continue
    }
    const client = new RelayClient({ relayUrl: relay.url, apiKey: relay.psk, channelId: environmentId, announceTrust })
    client.on('connected', () => log('relay client connected', { relay_url: relay.url, environment_id: environmentId, announced: !!announceTrust }))
    client.on('disconnected', () => log('relay client disconnected', { relay_url: relay.url }))
    client.connect()
    clients.push(client)
  }

  log('relay clients started', { relay_count: clients.length, announced: !!announceTrust })
  return {
    clients,
    close(): void {
      for (const client of clients) client.disconnect()
    },
  }
}
