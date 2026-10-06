/**
 * The subscription lookup request, version 1 of the contract in
 * `docs/configuration/subscription-lookup.md`: a GET with the person's bearer
 * token, answered with a JSON array of `{ id, label, key }`.
 *
 * `LookupFailure` carries what a person can act on. The status and a short
 * reason are the whole message; a body is never copied into it, because the
 * body of a successful lookup holds keys.
 */
import type { ServerSubscriptionLookupConfig } from '../config/subscription-lookup-config'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subscription-lookup', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('subscription-lookup', msg, fields)
}

/** The contract version this server speaks; sent on every request. */
export const LOOKUP_CONTRACT = '1'
export const VERSION_HEADER = 'Ion-Subscription-Lookup-Version'

/** Responses above this size are refused, matching the engine. */
const MAX_RESPONSE_BYTES = 1024 * 1024

/** One subscription a lookup returned. `key` is the secret: it is applied and never reported. */
export interface Subscription {
  id: string
  label: string
  key: string
}

/** A lookup that did not produce a usable answer. `reason` is safe to show a person. */
export class LookupFailure extends Error {
  constructor(public readonly reason: string, public readonly status?: number) {
    super(reason)
    this.name = 'LookupFailure'
  }
}

export type Fetcher = typeof fetch

/** Parses a version 1 response. Every entry needs all three fields and ids are unique, because a choice is remembered by id. */
export function decodeResponse(body: string): Subscription[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new LookupFailure('the lookup answered with something that is not JSON')
  }
  if (!Array.isArray(parsed)) throw new LookupFailure('the lookup did not answer with a list of subscriptions')
  const seen = new Set<string>()
  const out: Subscription[] = []
  parsed.forEach((entry, index) => {
    const e = (entry ?? {}) as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const label = typeof e.label === 'string' ? e.label : ''
    const key = typeof e.key === 'string' ? e.key : ''
    if (!id || !label || !key) throw new LookupFailure(`subscription ${index + 1} in the lookup answer is missing an id, label, or key`)
    if (seen.has(id)) throw new LookupFailure('the lookup answer repeats a subscription id')
    seen.add(id)
    out.push({ id, label, key })
  })
  return out
}

/** One lookup for one person's access token. Throws `LookupFailure`. */
export async function lookupSubscriptions(
  config: ServerSubscriptionLookupConfig,
  accessToken: string,
  doFetch: Fetcher = fetch,
): Promise<Subscription[]> {
  const started = Date.now()
  log('subscription lookup requested', { url: config.endpoint, provider: config.provider })
  let res: Response
  try {
    res = await doFetch(config.endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        [VERSION_HEADER]: LOOKUP_CONTRACT,
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    warn('subscription lookup request failed', { url: config.endpoint, timed_out: timedOut, error: String(err), duration_ms: Date.now() - started })
    throw new LookupFailure(timedOut ? 'the lookup timed out' : 'the lookup could not be reached')
  }
  const text = await res.text().catch(() => '')
  log('subscription lookup endpoint answered', { url: config.endpoint, status: res.status, bytes: text.length, duration_ms: Date.now() - started })
  if (text.length > MAX_RESPONSE_BYTES) throw new LookupFailure('the lookup answer was too large', res.status)
  if (res.status === 401) throw new LookupFailure('the lookup refused this sign-in (401)', res.status)
  if (res.status === 403) throw new LookupFailure('this account is not allowed to look up a subscription (403)', res.status)
  if (res.status < 200 || res.status > 299) throw new LookupFailure(`the lookup answered with status ${res.status}`, res.status)
  const subscriptions = decodeResponse(text)
  log('subscription lookup succeeded', { provider: config.provider, count: subscriptions.length, duration_ms: Date.now() - started })
  return subscriptions
}
