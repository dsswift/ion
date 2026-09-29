import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitCredentialStore } from '../../credential-store'
import { beginGithubAuthorize, completeGithubAuthorize, githubExchangeSource, GITHUB_HOST, _resetGithubExchangeCacheForTest } from '../exchange-github'
import type { ServerGitExchangeGithubConfig } from '../../../../config/server-config'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const cfg: ServerGitExchangeGithubConfig = { clientId: 'app-id', clientSecret: 'app-secret' }

let fetchMock: ReturnType<typeof vi.fn>
let dir: string
let store: GitCredentialStore

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  dir = mkdtempSync(join(tmpdir(), 'ion-exchange-github-test-'))
  store = new GitCredentialStore(dir)
  _resetGithubExchangeCacheForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('beginGithubAuthorize / completeGithubAuthorize', () => {
  it('completes an authorization and stores the exchange-github credential with the x-access-token username', async () => {
    const { state } = beginGithubAuthorize(cfg, { origin: 'https://server.example', subject: 'oidc:alice' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 28800 }))

    const result = await completeGithubAuthorize(cfg, { origin: 'https://server.example', code: 'auth-code', state }, store)
    expect(result).toEqual({ ok: true, subject: 'oidc:alice', host: GITHUB_HOST })
    expect(store.get('oidc:alice', GITHUB_HOST)?.username).toBe('x-access-token')
  })

  it('refuses an unknown state', async () => {
    expect(await completeGithubAuthorize(cfg, { origin: 'https://server.example', code: 'x', state: 'never-issued' }, store)).toEqual({ ok: false, reason: 'unknown_state' })
  })
})

describe('githubExchangeSource', () => {
  it('returns null for any host other than github.com', async () => {
    const source = githubExchangeSource(() => cfg, store)
    expect(await source.resolve('oidc:alice', 'github.example-enterprise.com')).toBeNull()
  })

  it('refreshes an expired access token', async () => {
    store.set({ subject: 'oidc:alice', host: GITHUB_HOST, source: 'exchange-github', kind: 'https-token', token: 'STALE', username: 'x-access-token', refreshToken: 'RT' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'FRESH', expires_in: 28800 }))

    const source = githubExchangeSource(() => cfg, store)
    const resolved = await source.resolve('oidc:alice', GITHUB_HOST)
    expect(resolved?.token).toBe('FRESH')
  })

  it('returns null when github exchange is not configured', async () => {
    const source = githubExchangeSource(() => null, store)
    expect(await source.resolve('oidc:alice', GITHUB_HOST)).toBeNull()
  })
})
