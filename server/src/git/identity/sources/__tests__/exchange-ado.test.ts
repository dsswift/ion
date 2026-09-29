import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ServerOidcConfig } from '../../../../config/server-config'
import { BrowserSessionStore, newSessionId } from '../../../../auth/browser-session-store'

const { refreshAccessToken } = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
vi.mock('../../../../auth/browser-oidc', () => ({ refreshAccessToken }))

import { adoExchangeSource, exchangeUserTokenForAdoToken, isAdoHost, _resetAdoExchangeCacheForTest } from '../exchange-ado'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const oidc: ServerOidcConfig = {
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  audience: 'api://server-app-id',
  scope: 'Studio.Access',
  clientId: 'spa-client-id',
  rolesToScopes: {},
  defaultScopes: [],
  allowedSubjects: [],
  clientSecret: 'server-secret',
}

const principal = { subject: 'oidc:alice', displayName: 'Alice' }

let fetchMock: ReturnType<typeof vi.fn>
let dir: string
let sessions: BrowserSessionStore

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  dir = mkdtempSync(join(tmpdir(), 'ion-exchange-ado-test-'))
  sessions = new BrowserSessionStore(dir)
  refreshAccessToken.mockReset()
  _resetAdoExchangeCacheForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('isAdoHost', () => {
  it('recognizes dev.azure.com and *.visualstudio.com', () => {
    expect(isAdoHost('dev.azure.com')).toBe(true)
    expect(isAdoHost('myorg.visualstudio.com')).toBe(true)
    expect(isAdoHost('github.com')).toBe(false)
  })
})

describe('exchangeUserTokenForAdoToken', () => {
  it('requests the jwt-bearer OBO grant against the tenant token endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'ADO-AT', expires_in: 3600 }))
    const result = await exchangeUserTokenForAdoToken(oidc, 'user-access-token')
    expect(result?.accessToken).toBe('ADO-AT')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(body.get('assertion')).toBe('user-access-token')
    expect(body.get('client_id')).toBe('server-app-id') // api:// prefix stripped
    expect(body.get('scope')).toBe('499b84ac-1321-427f-aa17-267ca6975798/.default')
  })

  it('returns null when the server has no client secret configured', async () => {
    const result = await exchangeUserTokenForAdoToken({ ...oidc, clientSecret: '' }, 'user-access-token')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('adoExchangeSource', () => {
  it('returns null for a non-ADO host', async () => {
    const source = adoExchangeSource(() => oidc, () => true, sessions)
    expect(await source.resolve('oidc:alice', 'github.com')).toBeNull()
  })

  it('returns null when ado exchange is disabled', async () => {
    const source = adoExchangeSource(() => oidc, () => false, sessions)
    expect(await source.resolve('oidc:alice', 'dev.azure.com')).toBeNull()
  })

  it('returns null when the subject has no browser session', async () => {
    const source = adoExchangeSource(() => oidc, () => true, sessions)
    expect(await source.resolve('oidc:alice', 'dev.azure.com')).toBeNull()
  })

  it('performs OBO using the subjects fresh browser session access token', async () => {
    sessions.create({ sessionId: newSessionId(), principal, scopes: [], accessToken: 'user-at', refreshToken: null, accessExpiresAt: Date.now() + 3600_000 })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'ADO-AT', expires_in: 3600 }))

    const source = adoExchangeSource(() => oidc, () => true, sessions)
    const resolved = await source.resolve('oidc:alice', 'dev.azure.com')
    expect(resolved).toEqual({ source: 'exchange-ado', kind: 'https-token', host: 'dev.azure.com', token: 'ADO-AT', username: 'oauth2' })
  })

  it('refreshes the browser sessions access token first when it has expired', async () => {
    const sessionId = newSessionId()
    sessions.create({ sessionId, principal, scopes: [], accessToken: 'stale-at', refreshToken: 'refresh-1', accessExpiresAt: Date.now() - 1000 })
    refreshAccessToken.mockResolvedValueOnce({ ok: true, accessToken: 'fresh-at', refreshToken: 'refresh-2', auth: { expiresAt: Date.now() + 3600_000 } })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'ADO-AT', expires_in: 3600 }))

    const source = adoExchangeSource(() => oidc, () => true, sessions)
    const resolved = await source.resolve('oidc:alice', 'dev.azure.com')
    expect(resolved?.token).toBe('ADO-AT')
    expect(sessions.tokensFor(sessionId)?.accessToken).toBe('fresh-at')
  })

  it('returns null when the expired sessions refresh fails', async () => {
    sessions.create({ sessionId: newSessionId(), principal, scopes: [], accessToken: 'stale-at', refreshToken: 'refresh-1', accessExpiresAt: Date.now() - 1000 })
    refreshAccessToken.mockResolvedValueOnce({ ok: false })

    const source = adoExchangeSource(() => oidc, () => true, sessions)
    expect(await source.resolve('oidc:alice', 'dev.azure.com')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches the OBO token and never re-derives it while fresh', async () => {
    sessions.create({ sessionId: newSessionId(), principal, scopes: [], accessToken: 'user-at', refreshToken: null, accessExpiresAt: Date.now() + 3600_000 })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'ADO-AT', expires_in: 3600 }))

    const source = adoExchangeSource(() => oidc, () => true, sessions)
    await source.resolve('oidc:alice', 'dev.azure.com')
    fetchMock.mockClear()

    const second = await source.resolve('oidc:alice', 'dev.azure.com')
    expect(second?.token).toBe('ADO-AT')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
