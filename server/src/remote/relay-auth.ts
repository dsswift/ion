/**
 * relay-auth.ts — relay OIDC auth config probe and scope composition.
 *
 * The relay serves GET /v1/auth/config to advertise its authentication mode.
 * This module fetches that config so the desktop can decide whether to connect
 * with a static PSK or a dynamically-minted OIDC token.
 *
 * Scope composition: OIDC relays follow the Microsoft Entra convention of
 * `api://<audience>/<requiredScope>`. The relay returns the audience (the
 * app-registration client ID) and the requiredScope (e.g. "Relay.Access")
 * separately; this module joins them into the full scope string the engine
 * passes to oidc_token.
 */

import { parseRelayAuthConfig, composeOidcScope, type RelayAuthConfig } from '@ion/shared/relay-auth-config'
import { log as _log } from '../logger'

export { composeOidcScope }
export type { RelayAuthConfig }

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay_auth', msg, fields)
}

/**
 * Fetch the relay's auth config from GET /v1/auth/config.
 *
 * Converts a ws(s):// relay URL to http(s)://, appends the path, and fetches
 * with a 5-second timeout. Returns null on any network error, HTTP error, or
 * malformed response — callers must treat null as "PSK mode / unknown".
 */
export async function probeRelayAuthConfig(relayUrl: string): Promise<RelayAuthConfig | null> {
  try {
    // Normalize: strip trailing slash, convert ws:// → http://, wss:// → https://
    let base = relayUrl.replace(/\/+$/, '')
    base = base
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')

    const url = `${base}/v1/auth/config`
    log('relay_auth: probing auth config', { url })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    let res: Response
    try {
      res = await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      log('relay_auth: auth config probe returned non-200', { status: res.status })
      return null
    }

    const data = parseRelayAuthConfig(await res.json() as unknown)
    if (!data) {
      log('relay_auth: auth config response malformed')
      return null
    }

    log('relay_auth: auth config received', { oidc: data.oidc, psk: data.psk, issuer_count: data.issuers?.length ?? 0 })
    return data
  } catch (err) {
    log('relay_auth: auth config probe failed', { error: (err as Error).message })
    return null
  }
}
