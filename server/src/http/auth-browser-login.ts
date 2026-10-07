/**
 * `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` -- the
 * server-held session flow for the browser Studio client (spec 18
 * successor). The server runs the PKCE exchange itself (`auth/browser-oidc.ts`)
 * and hands the browser only a session cookie (`auth/session-cookie.ts`),
 * never a token. See `auth/browser-session-store.ts` for where the session
 * persists.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { ServerOidcConfig } from '../config/server-config'
import { beginLogin, completeLogin } from '../auth/browser-oidc'
import type { BrowserSessionStore } from '../auth/browser-session-store'
import { newSessionId } from '../auth/browser-session-store'
import { isSecureRequest, originFor, parseCookie, setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from '../auth/session-cookie'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-browser-login-route', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-browser-login-route', msg, fields)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location })
  res.end()
}

/** Same-origin, root-relative paths only -- rejects an absolute URL or a protocol-relative `//host/...` an attacker could smuggle in via `returnTo` to redirect a signed-in user off-site (open-redirect). */
function safeReturnTo(raw: string | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

/** Builds the `GET /auth/login` route handler. */
export function authLoginRoute(getOidc: () => ServerOidcConfig | null): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const oidc = getOidc()
    if (!oidc) {
      warn('login refused: server has no oidc configured')
      writeJson(res, 400, { error: 'no_browser_sign_in' })
      return
    }
    const url = new URL(req.url ?? '/auth/login', 'http://placeholder')
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'))
    const origin = originFor(req)

    beginLogin(oidc, { origin, returnTo })
      .then(({ authorizeUrl }) => {
        log('login started', { origin })
        redirect(res, authorizeUrl)
      })
      .catch((err: unknown) => {
        warn('login refused: could not start authorization request', { error: String(err) })
        writeJson(res, 502, { error: 'idp_unreachable' })
      })
  }
}

/** Builds the `GET /auth/callback` route handler. */
export function authCallbackRoute(getOidc: () => ServerOidcConfig | null, sessions: BrowserSessionStore): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const oidc = getOidc()
    if (!oidc) {
      warn('callback refused: server has no oidc configured')
      redirect(res, '/')
      return
    }
    const url = new URL(req.url ?? '/auth/callback', 'http://placeholder')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
      warn('callback refused: missing code or state')
      redirect(res, '/')
      return
    }
    const origin = originFor(req)

    completeLogin(oidc, { origin, code, state })
      .then((result) => {
        if (!result.ok) {
          warn('callback refused', { reason: result.reason })
          redirect(res, '/')
          return
        }
        const sessionId = newSessionId()
        sessions.create({
          sessionId,
          principal: result.auth.principal,
          scopes: result.auth.scopes,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          accessExpiresAt: result.auth.expiresAt ?? Date.now() + 3600_000,
        })
        setSessionCookie(res, sessionId, isSecureRequest(req))
        log('callback accepted; session established', { subject: result.auth.principal.subject })
        redirect(res, result.returnTo)
      })
      .catch((err: unknown) => {
        warn('callback refused: unexpected error completing login', { error: String(err) })
        redirect(res, '/')
      })
  }
}

/** Builds the `POST /auth/logout` route handler. */
export function authLogoutRoute(sessions: BrowserSessionStore, onSignedOut: (subject: string) => void = () => undefined): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    const sessionId = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME)
    // The person this session belonged to, read before it is deleted: their applied key goes with the session.
    const subject = sessionId ? sessions.get(sessionId)?.principal.subject : undefined
    if (sessionId) sessions.delete(sessionId)
    if (subject) onSignedOut(subject)
    clearSessionCookie(res, isSecureRequest(req))
    log('logout completed', { had_session: !!sessionId })
    writeJson(res, 200, { ok: true })
  }
}
