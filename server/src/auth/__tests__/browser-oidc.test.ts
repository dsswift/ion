import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerOidcConfig } from '../../config/server-config'

const { verifyBearer } = vi.hoisted(() => ({ verifyBearer: vi.fn() }))
vi.mock('../bearer', () => ({ verifyBearer }))

import {
  beginLogin,
  completeLogin,
  refreshAccessToken,
  generatePkcePair,
  redirectUriFor,
  _resetBrowserOidcDiscoveryCacheForTest,
} from '../browser-oidc'

const oidc: ServerOidcConfig = {
  issuer: 'https://login.example.test/tenant',
  audience: 'api-audience',
  scope: 'Studio.User',
  clientId: 'browser-client-id',
  rolesToScopes: {},
  defaultScopes: ['conversations:read'],
  allowedSubjects: [],
    clientSecret: '',
}

const DISCOVERY_DOC = {
  authorization_endpoint: 'https://login.example.test/tenant/authorize',
  token_endpoint: 'https://login.example.test/tenant/token',
}

const ACCEPTED_AUTH = {
  ok: true as const,
  principal: { subject: 'josh', displayName: 'Josh' },
  scopes: ['conversations:read'] as const,
  expiresAt: Date.now() + 3600_000,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  _resetBrowserOidcDiscoveryCacheForTest()
  verifyBearer.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generatePkcePair', () => {
  it('produces a verifier and a distinct S256 challenge', () => {
    const { verifier, challengeS256 } = generatePkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challengeS256).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challengeS256).not.toBe(verifier)
  })
})

describe('redirectUriFor', () => {
  it('appends /auth/callback to the origin', () => {
    expect(redirectUriFor('https://ion.example.test')).toBe('https://ion.example.test/auth/callback')
  })
})

describe('beginLogin', () => {
  it('discovers the authorization endpoint and builds a PKCE authorize URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    const result = await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/some/path' })
    expect(result.authorizeUrl.startsWith(DISCOVERY_DOC.authorization_endpoint)).toBe(true)
    const url = new URL(result.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe('browser-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://ion.example.test/auth/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    expect(url.searchParams.get('state')).toBe(result.state)
  })

  it('caches discovery per issuer (one fetch across two logins)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DISCOVERY_DOC))
    await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/' })
    await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('completeLogin', () => {
  it('refuses an unknown state', async () => {
    const result = await completeLogin(oidc, { origin: 'https://ion.example.test', code: 'abc', state: 'never-issued' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown_state')
  })

  it('exchanges the code and verifies the resulting access token, consuming the state (single use)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    const begun = await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/target' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'issued-access-token', refresh_token: 'issued-refresh-token', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce(ACCEPTED_AUTH)

    const result = await completeLogin(oidc, { origin: 'https://ion.example.test', code: 'auth-code', state: begun.state })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accessToken).toBe('issued-access-token')
      expect(result.refreshToken).toBe('issued-refresh-token')
      expect(result.returnTo).toBe('/target')
      expect(result.auth.principal.subject).toBe('josh')
    }
    expect(verifyBearer).toHaveBeenCalledWith({ kind: 'bearer', token: 'issued-access-token' }, oidc)

    // Reusing the same state a second time is refused -- single use.
    const reused = await completeLogin(oidc, { origin: 'https://ion.example.test', code: 'auth-code', state: begun.state })
    expect(reused.ok).toBe(false)
  })

  it('refuses when the token endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    const begun = await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/' })
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }))
    const result = await completeLogin(oidc, { origin: 'https://ion.example.test', code: 'auth-code', state: begun.state })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('exchange_failed')
  })

  it('refuses when the exchanged access token fails verification', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    const begun = await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'bad-token', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce({ ok: false, reason: 'wrong_audience' })
    const result = await completeLogin(oidc, { origin: 'https://ion.example.test', code: 'auth-code', state: begun.state })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('wrong_audience')
  })
})

describe('refreshAccessToken', () => {
  it('exchanges the refresh token for a new access token and verifies it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'rotated-access', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce(ACCEPTED_AUTH)
    const result = await refreshAccessToken(oidc, 'old-refresh-token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accessToken).toBe('rotated-access')
      // No refresh_token in the response -- the caller's existing one is kept.
      expect(result.refreshToken).toBe('old-refresh-token')
    }
  })

  it('rotates the refresh token when the IdP issues a new one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce(ACCEPTED_AUTH)
    const result = await refreshAccessToken(oidc, 'old-refresh-token')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.refreshToken).toBe('rotated-refresh')
  })

  it('refuses when verification fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'bad-token', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce({ ok: false, reason: 'token_expired' })
    const result = await refreshAccessToken(oidc, 'old-refresh-token')
    expect(result.ok).toBe(false)
  })

  it('refuses when the token endpoint errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 401 }))
    const result = await refreshAccessToken(oidc, 'old-refresh-token')
    expect(result.ok).toBe(false)
  })

  it('refuses when discovery fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const result = await refreshAccessToken(oidc, 'old-refresh-token')
    expect(result.ok).toBe(false)
  })
})

describe('confidential-client mode', () => {
  // Registering the callback as a `Web` redirect URI (which is what a
  // server-side redemption requires -- an SPA URI is refused non-CORS with
  // AADSTS9002327) makes the IdP demand client authentication on every
  // token-endpoint call. Without this the exchange fails with
  // "client_secret required" and the browser loops through sign-in forever.
  const confidential: ServerOidcConfig = { ...oidc, clientSecret: 'server-side-secret' }

  function bodyOfLastPost(): URLSearchParams {
    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    return new URLSearchParams(String((init as RequestInit).body))
  }

  it('sends client_secret on the code exchange when one is configured', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    const begun = await beginLogin(confidential, { origin: 'https://ion.example.test', returnTo: '/' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce(ACCEPTED_AUTH)

    const result = await completeLogin(confidential, { origin: 'https://ion.example.test', code: 'c', state: begun.state })
    expect(result.ok).toBe(true)
    expect(bodyOfLastPost().get('client_secret')).toBe('server-side-secret')
  })

  it('sends client_secret on refresh too, because a confidential client authenticates on every call', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce(ACCEPTED_AUTH)

    const result = await refreshAccessToken(confidential, 'stored-refresh-token')
    expect(result.ok).toBe(true)
    expect(bodyOfLastPost().get('client_secret')).toBe('server-side-secret')
  })

  it('omits client_secret entirely when none is configured, so a public client stays public', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DISCOVERY_DOC))
    const begun = await beginLogin(oidc, { origin: 'https://ion.example.test', returnTo: '/' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
    verifyBearer.mockResolvedValueOnce(ACCEPTED_AUTH)

    await completeLogin(oidc, { origin: 'https://ion.example.test', code: 'c', state: begun.state })
    expect(bodyOfLastPost().has('client_secret')).toBe(false)
  })
})
