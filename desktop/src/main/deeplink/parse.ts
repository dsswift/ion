/**
 * `ion://` request parsing.
 *
 * Turns a URL into a typed request, or refuses it. Everything here is pure and
 * synchronous so it can be tested without a window, a filesystem, or an app.
 *
 * ── The two transports ───────────────────────────────────────────────────────
 * A request arrives one of two ways, and both normalize to the same
 * `DeepLinkRequest` before any action runs, so each action is written once:
 *
 *   - INLINE — parameters in the query string. What `dev` uses.
 *     `ion://terminal?tabId=…&title=api&cmd=npm%20run%20dev`
 *   - HANDOFF — the URI carries only an opaque id and the real payload is read
 *     from a private file: `ion://terminal?req=<uuid>`. For payloads too large
 *     for a URL (a multi-paragraph prompt) and for anything that should stay out
 *     of the system's opened-URL logging.
 *
 * Discrimination is simply whether `req` is present. This module resolves the
 * inline form completely and reports the handoff form as a pending id for
 * `handoff.ts` to read, because that read touches the filesystem.
 *
 * ── Why the caps exist ───────────────────────────────────────────────────────
 * Every field is length-capped. A URL can be arbitrarily long and arrives from
 * an untrusted origin, so the caps stop a hostile link from wedging the
 * confirmation dialog with a megabyte of text (the operator cannot make an
 * informed decision about a prompt they cannot read) and bound what reaches a
 * shell. A caller with a genuinely large payload uses the handoff transport,
 * which is bounded separately.
 */

/** Length caps, chosen to be generous for real use and hostile to abuse. */
export const LIMITS = {
  /** Comfortably longer than any UUID or engine-minted id. */
  tabId: 200,
  /** A pane label, e.g. a service name. */
  title: 120,
  /** An absolute path. */
  dir: 4096,
  /** A shell command line. */
  cmd: 8192,
  /** An inline prompt. Longer prompts belong on the handoff transport. */
  text: 16384,
  /** Capability token is fixed-size hex plus room for versioned formats. */
  token: 256,
} as const

export interface TerminalRequest {
  action: 'terminal'
  /** Target conversation. Empty means the caller did not name one. */
  tabId: string
  /** Optional pane label; falls back to the store's `Shell N` numbering. */
  title: string
  /** Optional command to run in the new pane. */
  cmd: string
  /** Optional working directory override. */
  dir: string
}

export interface PromptRequest {
  action: 'prompt'
  /** Directory the conversation should open in. */
  dir: string
  /** The prompt body. */
  text: string
  /** Whether to submit immediately rather than leaving it in the composer. */
  submit: boolean
}

export type DeepLinkPayload = TerminalRequest | PromptRequest

export interface DeepLinkRequest {
  payload: DeepLinkPayload
  /** Token supplied by the caller; validated by `token.ts`, not here. */
  token: string
  transport: 'inline' | 'handoff'
}

export type ParseResult =
  | { kind: 'ok'; request: DeepLinkRequest }
  /** A handoff id to resolve; the payload lives in a file. */
  | { kind: 'handoff'; id: string }
  | { kind: 'error'; reason: string }

/** Trim, and refuse rather than silently truncate an over-long value. */
function field(params: URLSearchParams, name: string, cap: number): string | null {
  const raw = params.get(name)
  if (raw === null) return ''
  const value = raw.trim()
  if (value.length > cap) return null
  // A NUL or newline in a field that may reach a shell, a path, or a log line
  // is never legitimate and is a classic injection carrier.
  if (/[\0\r\n]/.test(value)) return null
  return value
}

/**
 * Parse an `ion://` URL.
 *
 * Accepts `ion://<action>?…` and tolerates `ion:///<action>` (some openers
 * normalize the authority away, and refusing that would be an obscure failure
 * for a caller that did nothing wrong).
 */
export function parseDeepLink(rawUrl: string): ParseResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'error', reason: 'malformed url' }
  }

  if (url.protocol !== 'ion:') {
    return { kind: 'error', reason: `unexpected scheme ${url.protocol}` }
  }

  // `ion://terminal?x=1` puts "terminal" in host; `ion:///terminal` puts it in
  // pathname. Prefer host, fall back to the first path segment.
  const action = (url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase()
  const params = url.searchParams

  // A handoff id is resolved before the action is even considered, because the
  // file is the authority on what the request says.
  const req = params.get('req')
  if (req !== null) {
    const id = req.trim()
    // Strict UUID. This value becomes a filename, so anything looser is a path
    // traversal waiting to happen ("../../etc/passwd" must never be a valid id).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { kind: 'error', reason: 'handoff id is not a uuid' }
    }
    return { kind: 'handoff', id }
  }

  const token = field(params, 'token', LIMITS.token)
  if (token === null) return { kind: 'error', reason: 'token rejected (too long or illegal characters)' }

  if (action === 'terminal') {
    const tabId = field(params, 'tabId', LIMITS.tabId)
    const title = field(params, 'title', LIMITS.title)
    const cmd = field(params, 'cmd', LIMITS.cmd)
    const dir = field(params, 'dir', LIMITS.dir)
    if (tabId === null || title === null || cmd === null || dir === null) {
      return { kind: 'error', reason: 'terminal parameter rejected (too long or illegal characters)' }
    }
    return {
      kind: 'ok',
      request: { payload: { action: 'terminal', tabId, title, cmd, dir }, token, transport: 'inline' },
    }
  }

  if (action === 'prompt') {
    const dir = field(params, 'dir', LIMITS.dir)
    const text = field(params, 'text', LIMITS.text)
    if (dir === null || text === null) {
      return { kind: 'error', reason: 'prompt parameter rejected (too long or illegal characters)' }
    }
    if (!text) {
      return { kind: 'error', reason: 'prompt requires text' }
    }
    return {
      kind: 'ok',
      request: {
        payload: { action: 'prompt', dir, text, submit: params.get('submit') !== 'false' },
        token,
        transport: 'inline',
      },
    }
  }

  return { kind: 'error', reason: `unknown action ${action || '(none)'}` }
}

/**
 * Validate a payload that came from a handoff file.
 *
 * The file is 0600 and therefore locally written, but "local" is not "correct":
 * a malformed or over-long payload is still refused, so the two transports get
 * the same guarantees rather than the file path being a way around the caps.
 */
export function validateHandoffPayload(raw: unknown): { kind: 'ok'; payload: DeepLinkPayload } | { kind: 'error'; reason: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'error', reason: 'handoff payload is not an object' }
  }
  const o = raw as Record<string, unknown>
  const str = (v: unknown, cap: number): string | null => {
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string') return null
    const s = v.trim()
    if (s.length > cap) return null
    // Newlines are legitimate inside a handoff prompt — carrying multi-line
    // text is the transport's reason for existing — so only NUL is refused here.
    if (s.includes('\0')) return null
    return s
  }

  if (o.action === 'terminal') {
    const tabId = str(o.tabId, LIMITS.tabId)
    const title = str(o.title, LIMITS.title)
    const cmd = str(o.cmd, LIMITS.cmd)
    const dir = str(o.dir, LIMITS.dir)
    if (tabId === null || title === null || cmd === null || dir === null) {
      return { kind: 'error', reason: 'handoff terminal payload rejected' }
    }
    // A command reaching a shell must still be single-line, exactly as the
    // inline transport requires.
    if (/[\r\n]/.test(cmd)) {
      return { kind: 'error', reason: 'handoff cmd must be single-line' }
    }
    return { kind: 'ok', payload: { action: 'terminal', tabId, title, cmd, dir } }
  }

  if (o.action === 'prompt') {
    const dir = str(o.dir, LIMITS.dir)
    const text = str(o.text, LIMITS.text)
    if (dir === null || text === null) {
      return { kind: 'error', reason: 'handoff prompt payload rejected' }
    }
    if (!text) return { kind: 'error', reason: 'prompt requires text' }
    return { kind: 'ok', payload: { action: 'prompt', dir, text, submit: o.submit !== false } }
  }

  return { kind: 'error', reason: `unknown action ${String(o.action ?? '(none)')}` }
}
