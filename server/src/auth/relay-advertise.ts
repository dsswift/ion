/**
 * relay-advertise -- which relays this server is reachable through, and
 * what a paired client is told about them.
 *
 * Two sources, one answer:
 *  - `server.json.relays[]` on a deployed server (`ion studio install
 *    --relay`, or a hand edit);
 *  - the desktop's own Settings -> Remote relay (`settings.json`'s
 *    `relayUrl`/`relayApiKey`, the relay its iOS companion already uses)
 *    when `server.json` names none, so a laptop serves its own Environment
 *    through the relay to the operator's other desktop with nothing extra
 *    to configure.
 *
 * `advertisedRelays()` is what a pair response carries: the relay URL and
 * how to authenticate to it, so a client paired on the LAN can fall back to
 * the relay later without the key ever appearing in a link.
 */
import type { EnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import type { ServerConfig, ServerRelayConfig } from '../config/server-config'
import { readSettings } from '../persistence/settings-store'
import { relayIssuerInUse } from '../remote/relay-oidc-join'
import { getConfiguredOidcClientId } from '../oauth/entra-auth'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay-advertise', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('relay-advertise', msg, fields)
}

/** The relays this server maintains `ion`-role channels on. */
export function effectiveRelays(config: ServerConfig): ServerRelayConfig[] {
  if (config.relays.length > 0) {
    log('relays from server.json', { count: config.relays.length })
    return config.relays
  }
  let settings: Record<string, unknown>
  try {
    settings = readSettings()
  } catch (err) {
    warn('settings.json unreadable; no relay from desktop settings', { error: String(err) })
    return []
  }
  const url = typeof settings.relayUrl === 'string' ? settings.relayUrl.trim() : ''
  const key = typeof settings.relayApiKey === 'string' ? settings.relayApiKey : ''
  // A configured relay URL is the whole signal. There is no separate
  // enable toggle any more: a server is reachable by a phone because it is
  // a server, and it uses a relay because one was configured for it.
  if (!url) {
    log('no relay configured (server.json.relays empty and no relayUrl in settings)')
    return []
  }
  if (!key) {
    // No key means the relay authenticates with OIDC: this server joins
    // with a token from the operator's own identity, the way the desktop's
    // phone transport already does.
    log('relay from desktop settings', { relay_url: url, auth: 'oidc' })
    return [{ url, psk: '', oidc: true }]
  }
  log('relay from desktop settings', { relay_url: url, auth: 'psk' })
  return [{ url, psk: key }]
}

/** What a paired client is told so it can reach this server through each relay later. */
export function advertisedRelays(config: ServerConfig): EnvironmentRelay[] {
  return effectiveRelays(config).map((relay) => {
    if (config.oidc) {
      return { url: relay.url, auth: { mode: 'oidc', issuer: config.oidc.issuer, audience: config.oidc.audience, scope: config.oidc.scope } }
    }
    if (relay.oidc) {
      const issuer = relayIssuerInUse(relay.url)
      if (!issuer) {
        log('relay-oidc advertised without an issuer: this server has not joined it yet', { relay_url: relay.url })
        return { url: relay.url, auth: { mode: 'relay-oidc' } }
      }
      // This server joins with the operator identity, so the app that
      // identity signs in with is the one a client signs in with too.
      const clientId = getConfiguredOidcClientId()
      if (!clientId) warn('relay-oidc advertised without a sign-in app: engine.json names no identity client', { relay_url: relay.url, issuer })
      return { url: relay.url, auth: { mode: 'relay-oidc', issuer, ...(clientId ? { clientId } : {}) } }
    }
    return { url: relay.url, auth: { mode: 'psk', key: relay.psk } }
  })
}
