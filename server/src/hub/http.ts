/**
 * The hub's HTTP surface. `/healthz` and the sign-in routes are open. When
 * the hub has a sign-in, every other request — each page, each asset, each
 * API call — needs a signed-in session: a page is sent to sign in, an API
 * call is answered 401. Reading the Fleet needs any allowed person; running
 * an action or removing a server needs the `admin` scope.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { isHubAction, type HubActionResponse, type HubFleet } from '@ion/shared/fleet-hub'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import type { Scope } from '@ion/shared/studio-wire/types'
import type { BrowserSessionStore } from '../auth/browser-session-store'
import { authenticateSession } from '../auth/session-auth'
import { originFor, parseCookie, SESSION_COOKIE_NAME } from '../auth/session-cookie'
import { authCallbackRoute, authLoginRoute, authLogoutRoute } from '../http/auth-browser-login'
import { logIngestRoute } from '../http/log-ingest'
import type { HubConfig } from './config'
import type { HubRegistry } from './registry'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('hub.http', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('hub.http', msg, fields)
}

const MAX_BODY_BYTES = 64 * 1024
/** A header a page of another site cannot send without the browser asking first. */
const INTENT_HEADER = 'x-ion-hub'
const EVENTS_HEARTBEAT_MS = 25_000
/** Reports from many servers arrive in bursts; the page is told once per burst. */
const EVENTS_COALESCE_MS = 500

type Handler = (req: IncomingMessage, res: ServerResponse) => void

interface Caller {
  /** The name shown on the page. Absent on a hub with no sign-in. */
  user?: string
  /** The token's subject, for the log. Absent on a hub with no sign-in. */
  subject?: string
  canManage: boolean
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {})
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

export interface HubHttpDeps {
  config: HubConfig
  registry: HubRegistry
  sessions: BrowserSessionStore
  /** Serves the portal's files. */
  portal: Handler
}

export function hubRequestHandler(deps: HubHttpDeps): Handler {
  const { config, registry, sessions } = deps
  const getOidc = (): HubConfig['oidc'] => config.oidc
  const open: Record<string, Handler> = {
    '/healthz': (_req, res) => json(res, 200, { ok: true }),
    '/auth/login': authLoginRoute(getOidc),
    '/auth/callback': authCallbackRoute(getOidc, sessions),
    '/auth/logout': authLogoutRoute(sessions),
    // The portal's own log lines. The route attributes each line to the signed-in person, so a hub with no sign-in has nobody to attribute one to and takes none.
    '/log': config.oidc ? logIngestRoute({ getOidc, sessions }) : (_req, res) => { res.writeHead(204); res.end() },
  }

  async function caller(req: IncomingMessage): Promise<Caller | null> {
    if (!config.oidc) return { canManage: true }
    const auth = await authenticateSession(config.oidc, sessions, parseCookie(req.headers.cookie, SESSION_COOKIE_NAME))
    if (!auth.ok) return null
    const scopes: Scope[] = auth.scopes
    return { user: auth.principal.email ?? auth.principal.displayName ?? auth.principal.subject, subject: auth.principal.subject, canManage: scopeSatisfies(scopes, 'admin') }
  }

  /** A change must come from the hub's own page: the intent header, and the page's own origin when the browser names one. */
  function fromOwnPage(req: IncomingMessage): boolean {
    if (req.headers[INTENT_HEADER] !== '1') return false
    const origin = req.headers.origin
    return origin === undefined || origin === originFor(req)
  }

  function fleet(who: Caller): HubFleet {
    return { hub: { label: config.label, authRequired: config.oidc !== null, user: who.user, canManage: who.canManage, views: config.views }, servers: registry.list(), deploys: registry.listDeploys() }
  }

  function events(req: IncomingMessage, res: ServerResponse, who: Caller): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const push = (): void => { res.write(`event: fleet\ndata: ${JSON.stringify(fleet(who))}\n\n`) }
    push()
    let pending: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = registry.onChange(() => {
      if (pending) return
      pending = setTimeout(() => { pending = null; push() }, EVENTS_COALESCE_MS)
    })
    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n')
      if (!config.oidc) return
      // The stream outlives the request that opened it, so the sign-in is asked for again as it goes.
      caller(req)
        .then((still) => {
          if (still) return
          log('event stream ended: the person is no longer signed in', { subject: who.subject })
          res.end()
        })
        .catch((err: unknown) => warn('event stream sign-in check failed', { subject: who.subject, error: String(err) }))
    }, EVENTS_HEARTBEAT_MS)
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      unsubscribe()
      clearInterval(heartbeat)
      if (pending) clearTimeout(pending)
    }
    req.on('close', stop)
    res.on('close', stop)
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, who: Caller): Promise<void> {
    if (path === '/api/fleet' && req.method === 'GET') return json(res, 200, fleet(who))
    if (path === '/api/events' && req.method === 'GET') return events(req, res, who)
    const server = /^\/api\/servers\/([^/]+)(\/actions)?$/.exec(path)
    if (!server) return json(res, 404, { error: 'not_found' })
    const id = decodeURIComponent(server[1])
    const isAction = server[2] !== undefined && req.method === 'POST'
    const isRemove = server[2] === undefined && req.method === 'DELETE'
    const isRename = server[2] === undefined && req.method === 'PATCH'
    if (!isAction && !isRemove && !isRename) return json(res, 405, { error: 'method_not_allowed' })
    if (!fromOwnPage(req)) {
      warn('change refused: not from the hub\'s own page', { path, origin: req.headers.origin })
      return json(res, 403, { error: 'forbidden' })
    }
    if (!who.canManage) {
      warn('change refused: the person signed in may not manage', { path, subject: who.subject })
      return json(res, 403, { error: 'not_allowed' })
    }
    if (isRemove) {
      const removed = registry.remove(id)
      log('server removal requested', { environment_id: id, removed, subject: who.subject })
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown_server' })
    }
    let body: unknown
    try {
      body = await readBody(req)
    } catch (err) {
      warn('change refused: unreadable body', { error: String(err) })
      return json(res, 400, { error: 'bad_request' })
    }
    if (isRename) {
      const label = body && typeof body === 'object' ? (body as { label?: unknown }).label : undefined
      if (typeof label !== 'string') return json(res, 400, { error: 'bad_request' })
      const renamed = registry.rename(id, label)
      log('server rename requested', { environment_id: id, renamed, subject: who.subject })
      return json(res, renamed ? 200 : 404, renamed ? { ok: true } : { error: 'unknown_server' })
    }
    const request = body && typeof body === 'object' ? (body as { action?: unknown; args?: unknown }) : {}
    if (!isHubAction(request.action)) {
      warn('action refused: not an action a hub may ask for', { action: request.action, subject: who.subject })
      return json(res, 400, { error: 'unknown_action' })
    }
    log('action requested', { environment_id: id, action: request.action, subject: who.subject })
    const outcome = await registry.action(id, request.action, Array.isArray(request.args) ? request.args : [])
    if (outcome === 'unknown') return json(res, 404, { error: 'unknown_server' })
    const response: HubActionResponse = outcome === 'offline' ? { ok: false, error: 'This server is not connected to the hub now.' }
      : outcome === 'report_only' ? { ok: false, error: 'This server only reports to this hub; it does not run its actions.' }
      : outcome
    return json(res, 200, response)
  }

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const route = open[path]
    if (route) {
      route(req, res)
      return
    }
    caller(req)
      .then((who) => {
        if (!who) {
          if (path.startsWith('/api/')) return json(res, 401, { error: 'sign_in_required', login: '/auth/login' })
          res.writeHead(302, { Location: `/auth/login?returnTo=${encodeURIComponent(req.url ?? '/')}`, 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        if (path.startsWith('/api/')) return api(req, res, path, who)
        deps.portal(req, res)
      })
      .catch((err: unknown) => {
        warn('request failed', { path, error: String(err) })
        if (!res.headersSent) json(res, 500, { error: 'internal' })
      })
  }
}
