/**
 * The `ion_session` cookie: shared parsing/writing helpers for the HTTP
 * login/callback/logout routes (`http/auth-browser-login.ts`) and the
 * Studio WebSocket upgrade (`protocol/listener.ts`), so both read the exact
 * same cookie the exact same way.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { TLSSocket } from 'tls'

export const SESSION_COOKIE_NAME = 'ion_session'

/** Extracts one cookie's value from a raw `Cookie` request header. */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (key === name) return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * Whether this request arrived over TLS -- directly (`req.socket` is a real
 * `TLSSocket`) or via a reverse proxy that terminates it and forwards the
 * standard `X-Forwarded-Proto: https` header. This server has no TLS
 * termination of its own; a proxy-terminated deployment (Traefik, nginx,
 * an Azure/AWS load balancer) is the expected topology, so the header is
 * trusted the same way every such proxy's own backends do. Plain HTTP
 * (LAN/dev) omits `Secure` rather than silently failing to set the cookie.
 */
export function isSecureRequest(req: IncomingMessage): boolean {
  if (req.socket instanceof TLSSocket) return true
  return req.headers['x-forwarded-proto'] === 'https'
}

/** Writes the `Set-Cookie` header that establishes a session. */
export function setSessionCookie(res: ServerResponse, sessionId: string, secure: boolean): void {
  const attrs = [`${SESSION_COOKIE_NAME}=${sessionId}`, 'HttpOnly', 'SameSite=Lax', 'Path=/']
  if (secure) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

/** Writes the `Set-Cookie` header that clears the session cookie. */
export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  const attrs = [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0']
  if (secure) attrs.push('Secure')
  res.setHeader('Set-Cookie', attrs.join('; '))
}

/** Reconstructs the request's own origin (`https://host` or `http://host`), used as the OAuth `redirect_uri` base. */
export function originFor(req: IncomingMessage): string {
  const proto = isSecureRequest(req) ? 'https' : 'http'
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'
  return `${proto}://${host}`
}
