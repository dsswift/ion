/**
 * `POST /log` (spec 18 requirement: "Logging: `rendererLogger` in the web
 * host posts to `POST /log`"). A browser Studio client has no local socket
 * and no `desktop.jsonl` of its own to write to, so its `rendererLogger`
 * calls forward here instead. The server appends them to `server.jsonl`
 * stamped `component: 'web'` (see `logger.ts`'s `logWeb`) so a browser-side
 * failure is distinguishable from a server-side one in the same unified log
 * file.
 *
 * Accepts either credential a caller might present: a bearer token
 * (`verifyBearer`, unchanged from the original spec 18 design) or the
 * `ion_session` cookie the server-held session flow now uses instead
 * (`BrowserStudioHost.logWrite` sends neither header nor token -- the
 * cookie rides along on the request automatically). Either is sufficient
 * on its own; this is a plain HTTP POST with no scopes to grant and no
 * snapshot to build, so identifying the caller is the only question, not
 * authorizing them for anything beyond "may write a log line".
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { ServerOidcConfig } from '../config/server-config'
import { verifyBearer } from '../auth/bearer'
import type { BrowserSessionStore } from '../auth/browser-session-store'
import { parseCookie, SESSION_COOKIE_NAME } from '../auth/session-cookie'
import { logWeb, type LogLevel } from '../logger'
import { log as _log, warn as _warn } from '../logger'
import { withSpan } from '../tracing/op-span'
import { admitWebLine } from './log-ingest-budget'
import { isRepeatWebLine, rememberWebLine } from './log-ingest-seen'
import { SPAN_LOG_TAG } from '@ion/shared/trace-context'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log-ingest-route', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('log-ingest-route', msg, fields)
}

const MAX_BODY_BYTES = 16384

/**
 * Fields the SERVER owns on every line. A caller's copy is dropped rather
 * than merged: the logger lets caller fields win on collision (so a call site
 * can override an ambient value), which would let a browser stamp another
 * process's pid or another machine's identity onto its own lines and quietly
 * misattribute them in a central collector.
 */
const SERVER_OWNED_FIELDS = new Set(['pid', 'host', 'machine_id', 'mdm_device_id', 'mdm_serial', 'subject', 'component'])

/** Drop the fields above, keeping everything the client legitimately knows. */
function clientFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!SERVER_OWNED_FIELDS.has(k)) out[k] = v
  }
  return out
}
const LOG_LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds the ${MAX_BODY_BYTES}-byte cap`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function bearerTokenFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1] : null
}

export interface LogIngestDeps {
  /** `server.json.oidc` at request time -- read live, matching `auth-config.ts`'s `getOidc` pattern, since the value can change on a config reload. */
  getOidc: () => ServerOidcConfig | null
  sessions: BrowserSessionStore
}

/**
 * Builds the `POST /log` route handler for `http/health.ts`'s route table.
 * Refuses (401) with no oidc configured, or no valid bearer/session, since
 * an unauthenticated log-ingest endpoint would let anyone write into
 * `server.jsonl`. Accepts `{ level, tag, msg, fields? }`; `tag` is prefixed
 * `web:` so a filtered `jq` query can distinguish a forwarded browser line
 * from one this process wrote about itself. A span line (tag `span`) keeps its
 * tag unprefixed, and a `trace_id` field becomes the line's top-level trace_id.
 */
export function logIngestRoute(deps: LogIngestDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    const oidc = deps.getOidc()
    if (!oidc) {
      warn('log ingest refused: server.json has no oidc block')
      writeJson(res, 401, { error: 'unauthorized' })
      return
    }

    // One `log.ingest` span per batch, a child of the request's `http.request`.
    void withSpan('log.ingest', {}, async (_span, ctx) => {
      let subject: string | null = null
      const token = bearerTokenFrom(req)
      if (token) {
        const auth = await verifyBearer({ kind: 'bearer', token }, oidc).catch((err: unknown) => {
          log('log ingest: verifyBearer rejected unexpectedly; treating as unauthorized', { error: String(err) })
          return { ok: false as const }
        })
        if (auth.ok) subject = auth.principal.subject
        else warn('log ingest refused: bearer verification failed')
      } else {
        const sessionId = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME)
        const record = sessionId ? deps.sessions.get(sessionId) : undefined
        if (record) subject = record.principal.subject
        else warn('log ingest refused: no bearer token or valid session cookie presented')
      }

      if (!subject) {
        ctx.fail('unauthorized')
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }
      // The caller this batch is for: the request carried no principal the
      // span could inherit, so it names the one it authenticated.
      ctx.annotate({ user: subject })

      let raw: string
      try {
        raw = await readBody(req)
      } catch (err) {
        warn('log ingest refused: request body read failed', { error: String(err) })
        writeJson(res, 400, { error: 'bad_request' })
        return
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch (err) {
        warn('log ingest refused: request body is not valid JSON', { error: String(err) })
        writeJson(res, 400, { error: 'invalid_json' })
        return
      }

      const level = isLogLevel(body.level) ? body.level : 'INFO'
      const tag = typeof body.tag === 'string' && body.tag ? body.tag : 'web'
      const msg = typeof body.msg === 'string' ? body.msg : ''
      const fields = body.fields && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : {}
      if (!msg) {
        warn('log ingest refused: missing msg field')
        writeJson(res, 400, { error: 'missing_msg' })
        return
      }

      // A line the browser re-sent after a page load, which this server had
      // already written, is answered as delivered and not written twice.
      const lineId = typeof fields.line_id === 'string' && fields.line_id ? fields.line_id : ''
      if (lineId && isRepeatWebLine(subject, lineId)) {
        log('web log line already delivered; not written again', { subject, line_id: lineId })
        writeJson(res, 200, { ok: true, written: false, duplicate: true })
        return
      }

      // Charged before the line reaches the logger: the shared limiter never
      // limits ERROR, which is correct for the server's own lines and an open
      // door for a caller that picks its own level.
      const budget = admitWebLine(subject, Date.now())
      if (budget.dropped !== undefined) {
        warn('web log lines refused: caller is over its budget for this window', {
          subject,
          log_suppressed: budget.dropped,
        })
      }
      if (!budget.allow) {
        writeJson(res, 429, { error: 'rate_limited', written: false })
        return
      }
      if (lineId) rememberWebLine(subject, lineId)

      // `written` is the honest answer, not decoration. The route used to
      // reply `{ok:true}` whether the line reached `server.jsonl` or was
      // dropped by the level filter or the rate limiter, so a browser client
      // was told its diagnostics had landed when they had not -- and an
      // investigation reading the file afterwards saw an absence it could not
      // distinguish from "the client never logged anything".
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : ''
      // A span line keeps its tag: `span` is what marks a line as a span record
      // for the exporters, and `component=web` already says it came from a browser.
      const forwardedTag = tag === SPAN_LOG_TAG ? tag : `web:${tag}`
      const written = logWeb(level, forwardedTag, msg, {
        ...clientFields(fields),
        subject,
        ...(userAgent ? { user_agent: userAgent } : {}),
      })
      if (!written) {
        log('web log line accepted but not written (below level, or rate-limited)', {
          level, tag: forwardedTag, subject,
        })
      }
      ctx.annotate({ written })
      writeJson(res, 200, { ok: true, written })
    })
  }
}
