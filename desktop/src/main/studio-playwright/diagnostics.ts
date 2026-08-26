/**
 * Console and network diagnostics for the Studio browser.
 *
 * Retention is Playwright's, not ours. `page.consoleMessages()`,
 * `page.pageErrors()`, and `page.requests()` return the buffers the browser has
 * been filling since the page opened, with a `filter` for the current
 * navigation versus the whole session. That matters: a hand-rolled recorder
 * could only ever start when Ion attached, so anything the operator did before
 * that — the failed login, the 500 that started the investigation — would be
 * invisible. Using the retained buffers means the history is already there.
 *
 * Bodies are fetched lazily, only when an agent asks for a specific request.
 * Eagerly copying every response body would duplicate whole page payloads in
 * main-process memory for questions nobody asked.
 *
 * Nothing here is written to `desktop.jsonl`. Headers and bodies routinely
 * carry credentials, so they are redacted for the MODEL and never logged at
 * all.
 */
import type { ConsoleMessage, Page, Request } from 'playwright-core'
import { recordedRequests, type RecordedRequest, type RecordedView } from './network-recorder'

/** Header names whose values never reach the model or the logs. */
const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-amz-security-token',
])
/** Query parameters that commonly carry bearer-equivalent secrets. */
const REDACTED_QUERY = /^(access_token|id_token|refresh_token|token|api_?key|secret|signature|sig|password)$/i
const REDACTION = '[redacted]'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_CONSOLE_ENTRIES = 500
export const MAX_NETWORK_ENTRIES = 500

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug'

/** Levels included at each threshold, most severe first. */
const LEVEL_ORDER: Record<ConsoleLevel, number> = { error: 0, warning: 1, info: 2, debug: 3 }

export interface ConsoleEntry {
  level: ConsoleLevel
  text: string
  url: string
  line: number
  column: number
}

/** Map Playwright's console types onto the four MCP levels. */
export function consoleLevelOf(type: string): ConsoleLevel {
  if (type === 'error' || type === 'assert') return 'error'
  if (type === 'warning') return 'warning'
  if (type === 'debug' || type === 'trace' || type === 'count' || type === 'timeEnd') return 'debug'
  return 'info'
}

export function includesLevel(threshold: ConsoleLevel, level: ConsoleLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[threshold]
}

function consoleEntry(message: ConsoleMessage): ConsoleEntry {
  const location = message.location()
  return {
    level: consoleLevelOf(message.type()),
    text: message.text(),
    url: location.url,
    line: location.lineNumber,
    column: location.columnNumber,
  }
}

/**
 * Collect console output plus uncaught page errors at or above `threshold`.
 *
 * Page errors are folded in as error-level entries rather than reported
 * separately: an uncaught exception is the single most useful thing in this
 * list, and an agent asking for "errors" means both.
 */
export async function collectConsole(page: Page, threshold: ConsoleLevel, all: boolean): Promise<{ entries: ConsoleEntry[]; total: number; errors: number; warnings: number }> {
  const filter = all ? 'all' : 'since-navigation'
  const [messages, pageErrors] = await Promise.all([
    page.consoleMessages({ filter }),
    page.pageErrors({ filter }),
  ])
  const combined: ConsoleEntry[] = messages.map(consoleEntry)
  for (const error of pageErrors) {
    combined.push({ level: 'error', text: error.stack ? `${error.message}\n${error.stack}` : error.message, url: '', line: 0, column: 0 })
  }
  const total = combined.length
  const errors = combined.filter((entry) => entry.level === 'error').length
  const warnings = combined.filter((entry) => entry.level === 'warning').length
  const entries = combined.filter((entry) => includesLevel(threshold, entry.level))
  return { entries, total, errors, warnings }
}

/** Render the familiar `[level] text @ url:line:column` list. */
export function formatConsole(result: { entries: ConsoleEntry[]; total: number; errors: number; warnings: number }, threshold: ConsoleLevel): string {
  const lines = [`Total ${result.total} console message(s): ${result.errors} error(s), ${result.warnings} warning(s).`]
  if (result.entries.length !== result.total) lines.push(`Returning ${result.entries.length} message(s) at level "${threshold}" or more severe.`)
  const shown = result.entries.slice(0, MAX_CONSOLE_ENTRIES)
  for (const entry of shown) {
    const where = entry.url ? ` @ ${entry.url}:${entry.line}:${entry.column}` : ''
    lines.push(`[${entry.level}] ${entry.text}${where}`)
  }
  if (result.entries.length > shown.length) {
    lines.push(`... ${result.entries.length - shown.length} more message(s) omitted. Raise the level or pass a filename to capture everything.`)
  }
  return lines.join('\n')
}

/** Static assets are hidden by default so app requests stay readable. */
const STATIC_RESOURCE_TYPES = new Set(['stylesheet', 'image', 'media', 'font', 'script', 'manifest'])

/**
 * A recorded request as the list and detail views consume it.
 *
 * Sourced from `network-recorder.ts` rather than `page.requests()`: that API
 * has no navigation filter and documents that its entries may be garbage
 * collected, which would make an index an agent just read stop resolving.
 */
export type NetworkEntry = RecordedRequest

export function collectNetwork(page: Page, all: boolean): RecordedView {
  return recordedRequests(page, all)
}

/** Apply the `static` and regex filters while preserving stable indices. */
export function filterNetwork(entries: readonly NetworkEntry[], includeStatic: boolean, pattern: RegExp | null): NetworkEntry[] {
  return entries.filter((entry) => {
    if (pattern && !pattern.test(entry.url)) return false
    if (includeStatic) return true
    // A failed or erroring static asset is exactly the interesting case, so
    // "hide static" hides only the ones that succeeded.
    const succeeded = entry.failure === null && entry.status !== null && entry.status < 400
    return !(STATIC_RESOURCE_TYPES.has(entry.resourceType) && succeeded)
  })
}

export function formatNetworkList(shown: readonly NetworkEntry[], totalCount: number, includeStatic: boolean): string {
  if (shown.length === 0) return 'No matching network requests.'
  const lines = shown.slice(0, MAX_NETWORK_ENTRIES).map((entry) => {
    const outcome = entry.failure
      ? `[FAILED] ${entry.failure}`
      : entry.status === null
        ? '[PENDING]'
        : `[${entry.status}] ${entry.statusText}`.trimEnd()
    const duration = entry.durationMs === null ? '' : ` (${entry.durationMs}ms)`
    // Redacted here too, not only in the detail view: an OAuth callback or a
    // signed URL carries its token in the query string, and the list is the
    // view an agent reads first and most often.
    return `${entry.index}. [${entry.method}] ${redactUrl(entry.url)} => ${outcome}${duration} ${entry.resourceType}`
  })
  const hidden = totalCount - shown.length
  if (hidden > 0 && !includeStatic) lines.push(`... ${hidden} successful static resource request(s) hidden. Pass static: true to include them.`)
  else if (hidden > 0) lines.push(`... ${hidden} request(s) did not match the filter.`)
  if (shown.length > MAX_NETWORK_ENTRIES) lines.push(`... ${shown.length - MAX_NETWORK_ENTRIES} more request(s) omitted. Narrow with filter or pass a filename.`)
  return lines.join('\n')
}

export function redactHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${REDACTED_HEADERS.has(name.toLowerCase()) ? REDACTION : value}`)
    .sort()
}

/** Strip credential-bearing query parameters from a URL for display. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    let changed = false
    for (const key of [...url.searchParams.keys()]) {
      if (REDACTED_QUERY.test(key)) {
        url.searchParams.set(key, REDACTION)
        changed = true
      }
    }
    return changed ? url.toString() : raw
  } catch {
    return raw
  }
}

export type NetworkPart = 'request-headers' | 'request-body' | 'response-headers' | 'response-body'

/** Render one recorded request. Never issues a new one. */
export async function formatNetworkDetail(entry: NetworkEntry, part: NetworkPart | null): Promise<string> {
  const request = entry.request
  const response = await request.response().catch(() => null) // silent-ok: a pending or failed request legitimately has no response
  const sections: string[] = []

  if (!part || part === 'request-headers') {
    if (!part) {
      sections.push([
        '### General',
        `URL: ${redactUrl(entry.url)}`,
        `Method: ${entry.method}`,
        `Resource type: ${entry.resourceType}`,
        entry.failure ? `Failure: ${entry.failure}` : `Status: ${entry.status ?? 'pending'} ${entry.statusText}`.trimEnd(),
        entry.durationMs === null ? '' : `Duration: ${entry.durationMs}ms`,
      ].filter(Boolean).join('\n'))
    }
    const headers = await request.allHeaders().catch(() => ({}))
    sections.push(['### Request headers', ...redactHeaders(headers)].join('\n'))
  }

  if (!part || part === 'request-body') {
    const body = request.postData()
    if (body !== null || part) {
      sections.push(['### Request body', body === null ? '(no request body)' : truncateBody(body)].join('\n'))
    }
  }

  if (!part || part === 'response-headers') {
    if (!response) sections.push('### Response headers\n(no response)')
    else sections.push(['### Response headers', ...redactHeaders(await response.allHeaders().catch(() => ({})))].join('\n'))
  }

  if (part === 'response-body' || (!part && response)) {
    sections.push(['### Response body', await responseBody(response)].join('\n'))
  }

  return sections.join('\n\n')
}

async function responseBody(response: Awaited<ReturnType<Request['response']>>): Promise<string> {
  if (!response) return '(no response)'
  const headers: Record<string, string> = await response.allHeaders().catch(() => ({}))
  const type = headers['content-type'] ?? ''
  if (type && !/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/i.test(type)) {
    return `(binary or non-text body omitted; content-type ${type})`
  }
  try {
    return truncateBody(await response.text())
  } catch (err) {
    // A body is not retained forever, and asking after it expired is normal.
    // Saying so is more useful than an empty section.
    return `(body unavailable: ${String(err)})`
  }
}

function truncateBody(body: string): string {
  if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) return body
  return `${body.slice(0, MAX_BODY_BYTES)}\n... body truncated at ${MAX_BODY_BYTES} bytes.`
}

/** Compile a caller-supplied filter, refusing an invalid pattern clearly. */
export function compileFilter(raw: unknown): { pattern: RegExp | null; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { pattern: null }
  if (typeof raw !== 'string' || raw.length > 512) return { pattern: null, error: 'filter must be a regular expression string of at most 512 characters' }
  try {
    return { pattern: new RegExp(raw) }
  } catch (err) {
    return { pattern: null, error: `filter is not a valid regular expression: ${String(err)}` }
  }
}
