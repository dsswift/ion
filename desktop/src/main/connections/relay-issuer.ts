/**
 * relay-issuer -- which of a relay's accepted issuers this desktop presents.
 *
 * A relay may accept several issuers, one per identity tenant its operator
 * signs in from (`GET /v1/auth/config` -> `issuers[]`). A token is validated
 * against the entry whose issuer equals its `iss`, so the desktop asks for a
 * token for the audience and scope of the entry matching its own issuer.
 */
import { parseRelayAuthConfig, chooseRelayIssuer, type RelayIssuer } from '@ion/shared/relay-auth-config'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-relay-issuer', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-relay-issuer', msg, fields)
}

const PROBE_TIMEOUT_MS = 5_000

function authConfigUrl(relayUrl: string): string {
  const base = relayUrl.replace(/\/+$/, '').replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
  return `${base}/v1/auth/config`
}

/**
 * The relay's entry for `ownIssuer`. Throws with an operator-readable reason
 * when the relay cannot be asked, or does not accept that issuer -- the
 * broker reports it as the connection's failure.
 */
export async function relayIssuerFor(relayUrl: string, ownIssuer: string, fetchImpl: typeof fetch = fetch): Promise<RelayIssuer> {
  const url = authConfigUrl(relayUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let body: unknown
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = await res.json()
  } catch (err) {
    warn('relay auth config unreachable', { url, error: String(err) })
    throw new Error(`could not read how to sign in to relay ${relayUrl}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  const config = parseRelayAuthConfig(body)
  if (!config || !config.oidc) {
    warn('relay auth config is not an OIDC configuration', { url })
    throw new Error(`relay ${relayUrl} did not report an OIDC configuration`)
  }
  const entry = chooseRelayIssuer(config, ownIssuer)
  if (!entry) {
    warn('relay does not accept this desktop\'s issuer', { url, issuer: ownIssuer })
    throw new Error(`relay ${relayUrl} does not accept sign-ins from ${ownIssuer}`)
  }
  log('relay issuer entry selected', { url, issuer: entry.issuer, audience: entry.audience })
  return entry
}
