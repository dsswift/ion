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

import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay_auth', msg, fields)
}

/** Auth configuration advertised by the relay at GET /v1/auth/config. */
export interface RelayAuthConfig {
  /** True when the relay requires an OIDC bearer token for auth. */
  oidc: boolean
  /** OIDC issuer URL (e.g. https://login.microsoftonline.com/<tenantId>/v2.0). */
  issuer: string
  /** OAuth2 audience (app registration client ID). */
  audience: string
  /** The scope component after the audience (e.g. "Relay.Access"). */
  requiredScope: string
  /** True when the relay also accepts a pre-shared key. */
  psk: boolean
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

    const data = await res.json() as unknown
    if (!isRelayAuthConfig(data)) {
      log('relay_auth: auth config response malformed', { data })
      return null
    }

    log('relay_auth: auth config received', { oidc: data.oidc, psk: data.psk })
    return data
  } catch (err) {
    log('relay_auth: auth config probe failed', { error: (err as Error).message })
    return null
  }
}

function isRelayAuthConfig(value: unknown): value is RelayAuthConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.oidc === 'boolean' &&
    typeof v.issuer === 'string' &&
    typeof v.audience === 'string' &&
    typeof v.requiredScope === 'string' &&
    typeof v.psk === 'boolean'
  )
}

/**
 * Compose the full OIDC scope string from audience + requiredScope.
 *
 * Entra convention: `api://<audience>/<requiredScope>`.
 * Example: audience="abc123", requiredScope="Relay.Access"
 *          → "api://abc123/Relay.Access"
 *
 * If requiredScope already contains a slash (i.e., the relay already sends the
 * full scope), return it verbatim.
 */
export function composeOidcScope(audience: string, requiredScope: string): string {
  if (requiredScope.includes('/') || requiredScope.startsWith('api://')) {
    return requiredScope
  }
  // Audience may already carry the api:// prefix (e.g. "api://<relay-app-id>").
  // Don't double-prefix it.
  if (audience.startsWith('api://')) {
    return `${audience}/${requiredScope}`
  }
  return `api://${audience}/${requiredScope}`
}
