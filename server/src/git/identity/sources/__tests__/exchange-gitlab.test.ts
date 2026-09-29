import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitCredentialStore } from '../../credential-store'
import { beginGitlabAuthorize, completeGitlabAuthorize, gitlabExchangeSource, gitlabHost, _resetGitlabExchangeCacheForTest } from '../exchange-gitlab'
import type { ServerGitExchangeGitlabConfig } from '../../../../config/server-config'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const cfg: ServerGitExchangeGitlabConfig = { baseUrl: 'https://gitlab.example.com', clientId: 'app-id', clientSecret: 'app-secret' }

let fetchMock: ReturnType<typeof vi.fn>
let dir: string
let store: GitCredentialStore

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  dir = mkdtempSync(join(tmpdir(), 'ion-exchange-gitlab-test-'))
  store = new GitCredentialStore(dir)
  _resetGitlabExchangeCacheForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('gitlabHost', () => {
  it('extracts the instance hostname from baseUrl', () => {
    expect(gitlabHost(cfg)).toBe('gitlab.example.com')
  })
})

describe('beginGitlabAuthorize / completeGitlabAuthorize', () => {
  it('completes an authorization and stores the exchange-gitlab credential', async () => {
    const { state } = beginGitlabAuthorize(cfg, { origin: 'https://server.example', subject: 'oidc:alice' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))

    const result = await completeGitlabAuthorize(cfg, { origin: 'https://server.example', code: 'auth-code', state }, store)
    expect(result).toEqual({ ok: true, subject: 'oidc:alice', host: 'gitlab.example.com' })

    const record = store.get('oidc:alice', 'gitlab.example.com')
    expect(record?.source).toBe('exchange-gitlab')
    expect(store.tokenFor('oidc:alice', 'gitlab.example.com')).toBe('AT')
    expect(store.refreshTokenFor('oidc:alice', 'gitlab.example.com')).toBe('RT')
  })

  it('refuses an unknown or already-consumed state', async () => {
    const result = await completeGitlabAuthorize(cfg, { origin: 'https://server.example', code: 'x', state: 'never-issued' }, store)
    expect(result).toEqual({ ok: false, reason: 'unknown_state' })
  })
})

describe('gitlabExchangeSource', () => {
  it('returns null when gitlab exchange is not configured', async () => {
    const source = gitlabExchangeSource(() => null, store)
    expect(await source.resolve('oidc:alice', 'gitlab.example.com')).toBeNull()
  })

  it('returns null for a host that does not match the configured instance', async () => {
    const source = gitlabExchangeSource(() => cfg, store)
    expect(await source.resolve('oidc:alice', 'a-different-gitlab.example.com')).toBeNull()
  })

  it('returns the cached access token without a network call while it is still fresh', async () => {
    const { state } = beginGitlabAuthorize(cfg, { origin: 'https://server.example', subject: 'oidc:alice' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
    await completeGitlabAuthorize(cfg, { origin: 'https://server.example', code: 'x', state }, store)
    fetchMock.mockClear()

    const source = gitlabExchangeSource(() => cfg, store)
    const resolved = await source.resolve('oidc:alice', 'gitlab.example.com')
    expect(resolved).toEqual({ source: 'exchange-gitlab', kind: 'https-token', host: 'gitlab.example.com', token: 'AT', username: 'oauth2' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes an expired access token via the stored refresh token', async () => {
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'exchange-gitlab', kind: 'https-token', token: 'STALE-AT', username: 'oauth2', refreshToken: 'RT' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'FRESH-AT', refresh_token: 'RT2', expires_in: 3600 }))

    const source = gitlabExchangeSource(() => cfg, store)
    const resolved = await source.resolve('oidc:alice', 'gitlab.example.com')
    expect(resolved?.token).toBe('FRESH-AT')
    expect(store.tokenFor('oidc:alice', 'gitlab.example.com')).toBe('FRESH-AT')
    expect(store.refreshTokenFor('oidc:alice', 'gitlab.example.com')).toBe('RT2')
  })

  it('returns null when no refresh token is stored and the cache is empty', async () => {
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'exchange-gitlab', kind: 'https-token', token: 'AT', username: 'oauth2' })
    const source = gitlabExchangeSource(() => cfg, store)
    expect(await source.resolve('oidc:alice', 'gitlab.example.com')).toBeNull()
  })

  it('never resolves a record sourced from something other than exchange-gitlab', async () => {
    store.set({ subject: 'oidc:alice', host: 'gitlab.example.com', source: 'user', kind: 'https-token', token: 'USER-TOKEN', username: 'alice' })
    const source = gitlabExchangeSource(() => cfg, store)
    expect(await source.resolve('oidc:alice', 'gitlab.example.com')).toBeNull()
  })
})
