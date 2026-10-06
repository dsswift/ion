/**
 * The one HTTP call every hosting provider makes: JSON in, JSON out, the
 * outcome logged, and a refusal raised as a {@link GitHostingError} carrying
 * the host's own message.
 */
import type { GitHostingProviderKind } from '@ion/shared/types-git-hosting'
import { GitHostingError } from './types'
import { log as _log, warn as _warn } from '../../logger'

const TAG = 'git-hosting'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface HostingCall {
  provider: GitHostingProviderKind
  host: string
  /** What the call is for, in the log's words (`account`, `owners`, `create`). */
  operation: string
  url: string
  method?: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  /** Reads the host's error message out of a refused response's parsed body. */
  errorMessage(body: unknown, status: number): string | null
}

function parse(text: string): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { return text } // silent-ok: a non-JSON body is passed on as text for the error message
}

/** Runs one call and returns its parsed body. */
export async function hostingCall<T>(call: HostingCall): Promise<T> {
  const started = Date.now()
  const method = call.method ?? 'GET'
  const fields = { provider: call.provider, git_host: call.host, operation: call.operation, method }
  let res: Response
  try {
    res = await fetch(call.url, {
      method,
      headers: { Accept: 'application/json', ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...call.headers },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    warn('hosting call did not complete', { ...fields, error: String(err), duration_ms: Date.now() - started })
    throw new GitHostingError(0, `${call.host} could not be reached: ${err instanceof Error ? err.message : String(err)}`)
  }
  const body = parse(await res.text())
  if (!res.ok) {
    const message = call.errorMessage(body, res.status) ?? (typeof body === 'string' && body ? body.slice(0, 300) : `${call.host} answered ${res.status}`)
    warn('hosting call refused', { ...fields, status: res.status, error: message, duration_ms: Date.now() - started })
    throw new GitHostingError(res.status, message)
  }
  log('hosting call done', { ...fields, status: res.status, duration_ms: Date.now() - started })
  return body as T
}

/** A parsed body as a record, or an empty one. */
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** A string field of a parsed body, or ''. */
export function text(value: unknown, key: string): string {
  const v = record(value)[key]
  return typeof v === 'string' ? v : ''
}
