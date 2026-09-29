import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'http'
import { TLSSocket } from 'tls'
import { parseCookie, isSecureRequest, originFor, SESSION_COOKIE_NAME } from '../session-cookie'

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
