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
import { abandonedLogin, beginLogin, completeLogin } from '../auth/browser-oidc'
import type { BrowserSessionStore } from '../auth/browser-session-store'
import { newSessionId } from '../auth/browser-session-store'
import { authenticateSession } from '../auth/session-auth'
import { TEMPORARILY_UNAVAILABLE } from '../protocol/hello'
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
    // `silent=1`: a page that lost its session asks the provider to sign the person back in without showing
    // anything. Only the app sets it; the sign-in page a person lands on is always interactive.
    const silent = url.searchParams.get('silent') === '1'

    beginLogin(oidc, { origin, returnTo, silent })
      .then(({ authorizeUrl }) => {
        log('login started', { origin, silent })
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
    const providerError = url.searchParams.get('error')
    if (providerError) {
      // A silent sign-in the provider could not finish on its own: the person's sign-in there has ended.
      // Send them to the interactive sign-in, which shows the provider's own page, not a broken app.
      const next = abandonedLogin(state, providerError)
      if (next?.nextInteractive) {
        log('silent sign-in needs the person; starting an interactive sign-in', { reason: providerError })
        redirect(res, `/auth/login?returnTo=${encodeURIComponent(next.returnTo)}`)
        return
      }
      warn('callback refused: the provider returned an error', { reason: providerError })
      redirect(res, '/')
      return
    }
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

/**
 * Builds the `GET /auth/session` route handler: does this browser's session still work?
 *
 * A page that has been asleep asks this before anything else, so it learns the session is gone from one
 * answer instead of from every request it would otherwise fire. 200 means the session is good (it has been
 * refreshed if it was close to expiring, and its cookie lifetime is extended). 401 means it is unknown or
 * can never refresh again: sign in. 503 means the sign-in service could not be reached just now: the
 * session is kept, try again.
 */
export function authSessionRoute(getOidc: () => ServerOidcConfig | null, sessions: BrowserSessionStore): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    const sessionId = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME)
    void authenticateSession(getOidc(), sessions, sessionId).then((auth) => {
      if (auth.ok) {
        // Sliding: a session in use keeps its cookie as long as the server keeps the session.
        if (sessionId) setSessionCookie(res, sessionId, isSecureRequest(req))
        writeJson(res, 200, { ok: true })
        return
      }
      if (auth.reason === TEMPORARILY_UNAVAILABLE) {
        writeJson(res, 503, { error: 'temporarily_unavailable' })
        return
      }
      writeJson(res, 401, { error: 'unauthorized' })
    }).catch((err: unknown) => {
      warn('session check failed unexpectedly', { error: String(err) })
      writeJson(res, 503, { error: 'temporarily_unavailable' })
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
