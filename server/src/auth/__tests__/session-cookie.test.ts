import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'http'
import { TLSSocket } from 'tls'
import { parseCookie, isSecureRequest, originFor, setSessionCookie, SESSION_COOKIE_NAME, SESSION_IDLE_TTL_SECONDS } from '../session-cookie'
import type { ServerResponse } from 'http'

function fakeReq(opts: { headers?: Record<string, string>; tls?: boolean }): IncomingMessage {
  return {
    headers: opts.headers ?? {},
    socket: opts.tls ? Object.create(TLSSocket.prototype) : {},
  } as unknown as IncomingMessage
}

describe('parseCookie', () => {
  it('extracts the named cookie from a multi-cookie header', () => {
    expect(parseCookie('foo=1; ion_session=abc123; bar=2', SESSION_COOKIE_NAME)).toBe('abc123')
  })

  it('returns null when the cookie is absent', () => {
    expect(parseCookie('foo=1; bar=2', SESSION_COOKIE_NAME)).toBeNull()
  })

  it('returns null when the header itself is absent', () => {
    expect(parseCookie(undefined, SESSION_COOKIE_NAME)).toBeNull()
  })
})

describe('isSecureRequest', () => {
  it('is true for a real TLS socket', () => {
    expect(isSecureRequest(fakeReq({ tls: true }))).toBe(true)
  })

  it('is true when x-forwarded-proto is https (reverse-proxy TLS termination)', () => {
    expect(isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'https' } }))).toBe(true)
  })

  it('is false on plain HTTP with no forwarded-proto header', () => {
    expect(isSecureRequest(fakeReq({}))).toBe(false)
  })

  it('is false when x-forwarded-proto is http', () => {
    expect(isSecureRequest(fakeReq({ headers: { 'x-forwarded-proto': 'http' } }))).toBe(false)
  })
})

describe('originFor', () => {
  it('prefers x-forwarded-host over host', () => {
    expect(originFor(fakeReq({ headers: { host: 'internal:7331', 'x-forwarded-host': 'ion.example.test', 'x-forwarded-proto': 'https' } }))).toBe('https://ion.example.test')
  })

  it('falls back to the host header on plain HTTP', () => {
    expect(originFor(fakeReq({ headers: { host: 'localhost:7331' } }))).toBe('http://localhost:7331')
  })
})

describe('setSessionCookie', () => {
  function written(secure: boolean): string {
    let header = ''
    setSessionCookie({ setHeader: (_name: string, value: string) => { header = value } } as unknown as ServerResponse, 'abc', secure)
    return header
  }

  // The cookie used to be a browser-session cookie: closing the browser lost it while the server still
  // held a working session, so a restart forced a sign-in for nothing.
  it('outlives a browser restart, for as long as the server keeps the session', () => {
    expect(written(true)).toContain(`Max-Age=${SESSION_IDLE_TTL_SECONDS}`)
    expect(SESSION_IDLE_TTL_SECONDS).toBe(90 * 24 * 60 * 60)
  })

  it('stays HttpOnly and SameSite=Lax, and is Secure only behind HTTPS', () => {
    const https = written(true)
    expect(https).toContain('HttpOnly')
    expect(https).toContain('SameSite=Lax')
    expect(https).toContain('Secure')
    expect(written(false)).not.toContain('Secure')
  })
})
