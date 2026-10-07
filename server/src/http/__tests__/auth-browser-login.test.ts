import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHealth, type HealthHandle } from '../health'

const { beginLogin, completeLogin, abandonedLogin, refreshAccessToken } = vi.hoisted(() => ({ beginLogin: vi.fn(), completeLogin: vi.fn(), abandonedLogin: vi.fn(), refreshAccessToken: vi.fn() }))
vi.mock('../../auth/browser-oidc', () => ({ beginLogin, completeLogin, abandonedLogin, refreshAccessToken }))

import { authLoginRoute, authCallbackRoute, authLogoutRoute, authSessionRoute } from '../auth-browser-login'
import { BrowserSessionStore } from '../../auth/browser-session-store'
import type { ServerOidcConfig } from '../../config/server-config'

const OIDC: ServerOidcConfig = {
  issuer: 'https://login.example.test/tenant',
  audience: 'api-audience',
  scope: 'Studio.User',
  clientId: 'browser-client-id',
  rolesToScopes: {},
  defaultScopes: ['conversations:read'],
  allowedSubjects: [],
    clientSecret: '',
}

let health: HealthHandle
let dir: string
let sessions: BrowserSessionStore

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-auth-browser-login-route-test-'))
  sessions = new BrowserSessionStore(dir)
  beginLogin.mockReset()
  completeLogin.mockReset()
  abandonedLogin.mockReset()
  refreshAccessToken.mockReset()
  health = startHealth({
    port: 0,
    routes: {
      '/auth/login': authLoginRoute(() => OIDC),
      '/auth/callback': authCallbackRoute(() => OIDC, sessions),
      '/auth/logout': authLogoutRoute(sessions),
      '/auth/session': authSessionRoute(() => OIDC, sessions),
    },
  })
})

afterEach(async () => {
  await health.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /auth/login', () => {
  it('redirects to the IdP authorize URL', async () => {
    beginLogin.mockResolvedValueOnce({ authorizeUrl: 'https://login.example.test/tenant/authorize?foo=bar', state: 'state-1' })
    const res = await fetch(`${baseUrl(health)}/auth/login?returnTo=/some/path`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://login.example.test/tenant/authorize?foo=bar')
    expect(beginLogin).toHaveBeenCalledWith(OIDC, expect.objectContaining({ returnTo: '/some/path' }))
  })

  it('starts a silent sign-in only when the page asks for one', async () => {
    beginLogin.mockResolvedValue({ authorizeUrl: 'https://login.example.test/authorize', state: 's' })
    await fetch(`${baseUrl(health)}/auth/login?returnTo=/x&silent=1`, { redirect: 'manual' })
    expect(beginLogin).toHaveBeenLastCalledWith(OIDC, expect.objectContaining({ silent: true }))
    await fetch(`${baseUrl(health)}/auth/login?returnTo=/x`, { redirect: 'manual' })
    expect(beginLogin).toHaveBeenLastCalledWith(OIDC, expect.objectContaining({ silent: false }))
  })

  it('rejects an absolute-URL returnTo (open-redirect guard) by falling back to /', async () => {
    beginLogin.mockResolvedValueOnce({ authorizeUrl: 'https://login.example.test/authorize', state: 's' })
    await fetch(`${baseUrl(health)}/auth/login?returnTo=https://evil.example`, { redirect: 'manual' })
    expect(beginLogin).toHaveBeenCalledWith(OIDC, expect.objectContaining({ returnTo: '/' }))
  })

  it('rejects a protocol-relative returnTo by falling back to /', async () => {
    beginLogin.mockResolvedValueOnce({ authorizeUrl: 'https://login.example.test/authorize', state: 's' })
    await fetch(`${baseUrl(health)}/auth/login?returnTo=//evil.example`, { redirect: 'manual' })
    expect(beginLogin).toHaveBeenCalledWith(OIDC, expect.objectContaining({ returnTo: '/' }))
  })

  it('502s when beginLogin fails (e.g. IdP discovery unreachable)', async () => {
    beginLogin.mockRejectedValueOnce(new Error('discovery unreachable'))
    const res = await fetch(`${baseUrl(health)}/auth/login`, { redirect: 'manual' })
    expect(res.status).toBe(502)
  })
})

describe('GET /auth/callback', () => {
  it('on success: creates a session, sets the cookie, and redirects to returnTo', async () => {
    completeLogin.mockResolvedValueOnce({
      ok: true,
      auth: { ok: true, principal: { subject: 'josh', displayName: 'Josh' }, scopes: ['conversations:read'], expiresAt: Date.now() + 3600_000 },
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      returnTo: '/target',
    })
    const res = await fetch(`${baseUrl(health)}/auth/callback?code=abc&state=xyz`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/target')
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toContain('ion_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=7776000')

    const sessionId = cookie!.match(/ion_session=([^;]+)/)![1]
    const record = sessions.get(sessionId)
    expect(record?.principal.subject).toBe('josh')
  })

  it('redirects to / with no cookie when completeLogin refuses', async () => {
    completeLogin.mockResolvedValueOnce({ ok: false, reason: 'unknown_state' })
    const res = await fetch(`${baseUrl(health)}/auth/callback?code=abc&state=xyz`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('redirects to / with no cookie when code/state are missing', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/callback`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(completeLogin).not.toHaveBeenCalled()
  })
})

describe('GET /auth/callback when the provider answers with an error', () => {
  it('sends a silent sign-in that needs the person on to an interactive one, to the same place', async () => {
    abandonedLogin.mockReturnValueOnce({ nextInteractive: true, returnTo: '/deep/path?x=1' })
    const res = await fetch(`${baseUrl(health)}/auth/callback?error=login_required&state=s1`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/auth/login?returnTo=${encodeURIComponent('/deep/path?x=1')}`)
    expect(abandonedLogin).toHaveBeenCalledWith('s1', 'login_required')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('lands on / with no cookie for any other provider error', async () => {
    abandonedLogin.mockReturnValueOnce(null)
    const res = await fetch(`${baseUrl(health)}/auth/callback?error=access_denied&state=s1`, { redirect: 'manual' })
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(completeLogin).not.toHaveBeenCalled()
  })
})

describe('GET /auth/session', () => {
  const live = () => sessions.create({ sessionId: 'live', principal: { subject: 'josh', displayName: 'Josh' }, scopes: [], accessToken: 'a', refreshToken: 'r', accessExpiresAt: Date.now() + 3600_000 })

  it('says 200 for a session that works, and extends its cookie', async () => {
    const { sessionId } = live()
    const res = await fetch(`${baseUrl(health)}/auth/session`, { headers: { Cookie: `ion_session=${sessionId}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('says 401 for a session the server has forgotten, and for no cookie at all', async () => {
    const forgotten = await fetch(`${baseUrl(health)}/auth/session`, { headers: { Cookie: 'ion_session=wiped-yesterday' } })
    expect(forgotten.status).toBe(401)
    expect(forgotten.headers.get('set-cookie')).toBeNull()
    expect((await fetch(`${baseUrl(health)}/auth/session`)).status).toBe(401)
  })

  it('says 503, not 401, when the sign-in service is down, and keeps the session', async () => {
    sessions.create({ sessionId: 'stale', principal: { subject: 'josh', displayName: 'Josh' }, scopes: [], accessToken: 'a', refreshToken: 'r', accessExpiresAt: Date.now() - 1000 })
    refreshAccessToken.mockResolvedValueOnce({ ok: false, transient: true })
    const res = await fetch(`${baseUrl(health)}/auth/session`, { headers: { Cookie: 'ion_session=stale' } })
    expect(res.status).toBe(503)
    expect(sessions.get('stale')).toBeDefined()
  })

  it('refuses anything but GET', async () => {
    expect((await fetch(`${baseUrl(health)}/auth/session`, { method: 'POST' })).status).toBe(405)
  })
})

describe('POST /auth/logout', () => {
  it('deletes the session and clears the cookie', async () => {
    const record = sessions.create({
      sessionId: 'session-to-delete',
      principal: { subject: 'josh', displayName: 'Josh' },
      scopes: [],
      accessToken: 'a',
      refreshToken: null,
      accessExpiresAt: 0,
    })
    const res = await fetch(`${baseUrl(health)}/auth/logout`, { method: 'POST', headers: { Cookie: `ion_session=${record.sessionId}` } })
    expect(res.status).toBe(200)
    expect(sessions.get(record.sessionId)).toBeUndefined()
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toContain('Max-Age=0')
  })

  it('is a no-op (not an error) with no cookie present', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/logout`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('refuses a non-POST method with 405', async () => {
    const res = await fetch(`${baseUrl(health)}/auth/logout`, { method: 'GET' })
    expect(res.status).toBe(405)
  })
})
