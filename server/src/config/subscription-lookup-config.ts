/**
 * `server.json.subscriptionLookup` -- where a hosted instance gets a person's
 * provider key from. The server calls `endpoint` with that person's own
 * access token and applies the key it returns, per person.
 *
 * It is the server-side counterpart of the engine's `subscriptionLookup`
 * (`docs/configuration/subscription-lookup.md`), and speaks the same version 1
 * request and response contract. The engine's own lookup follows the
 * engine process's identity, which on a headless host is a workload identity,
 * not the person who signed in to this server through a browser; the person's
 * token lives here, in their browser session.
 *
 * Absent means no lookup runs and `providerCredentials[]` and the engine's
 * own levels serve exactly as before.
 */
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-config', msg, fields)
}

export interface ServerSubscriptionLookupConfig {
  /** The `http` or `https` URL called with the person's bearer token. */
  endpoint: string
  /** The provider id the key authenticates, a key under the engine's `providers`. Stored lowercase. */
  provider: string
  /** The scope the person's token is minted for, such as `api://<app-id>/Gateway.Keys.Read`. */
  scope: string
  /** The provider's name as people read it, such as `dci Marketing`. Empty shows the provider id. */
  displayName: string
  /** The header the key is sent under, such as `x-api-key`. Empty means the provider's own default. */
  header: string
  /** Bound on one lookup. */
  timeoutMs: number
  /** How long an applied key is reused without a lookup. 0 reuses it until a lookup is requested. */
  cacheMaxAgeSeconds: number
  /** Makes the person choose even when exactly one subscription comes back. */
  requireSelection: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000

/** True for an absolute `http` or `https` URL with a host. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== ''
  } catch {
    return false
  }
}

/** A block missing `endpoint`, `provider`, or `scope`, or naming a non-http endpoint, is logged and treated as absent. */
export function parseSubscriptionLookup(raw: unknown): ServerSubscriptionLookupConfig | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') {
    warn('server.json.subscriptionLookup is not an object; treating as absent')
    return null
  }
  const o = raw as Record<string, unknown>
  const endpoint = typeof o.endpoint === 'string' ? o.endpoint.trim() : ''
  const provider = typeof o.provider === 'string' ? o.provider.trim().toLowerCase() : ''
  const scope = typeof o.scope === 'string' ? o.scope.trim() : ''
  if (!endpoint || !provider || !scope || !isHttpUrl(endpoint)) {
    warn('server.json.subscriptionLookup needs an http(s) endpoint, a provider, and a scope; treating as absent', {
      has_endpoint: !!endpoint, endpoint_is_http: endpoint !== '' && isHttpUrl(endpoint), has_provider: !!provider, has_scope: !!scope,
    })
    return null
  }
  const timeoutMs = typeof o.timeoutMs === 'number' && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? Math.floor(o.timeoutMs) : DEFAULT_TIMEOUT_MS
  const cacheMaxAgeSeconds = typeof o.cacheMaxAgeSeconds === 'number' && Number.isFinite(o.cacheMaxAgeSeconds) && o.cacheMaxAgeSeconds > 0 ? Math.floor(o.cacheMaxAgeSeconds) : 0
  return {
    endpoint,
    provider,
    scope,
    displayName: typeof o.displayName === 'string' ? o.displayName.trim() : '',
    header: typeof o.header === 'string' ? o.header.trim() : '',
    timeoutMs,
    cacheMaxAgeSeconds,
    requireSelection: o.requireSelection === true,
  }
}
