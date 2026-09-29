import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuthCodeFlow } from '../oauth-code-exchange'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>
let flow: OAuthCodeFlow

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  flow = new OAuthCodeFlow('test-provider')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OAuthCodeFlow: beginAuthorize / consumePending', () => {
  it('produces a URL carrying the authorize params and a state that resolves back to the pending entry', () => {
    const { url, state } = flow.beginAuthorize({
      authorizeUrl: 'https://provider.example/oauth/authorize',
      clientId: 'client-1',
      redirectUri: 'https://server.example/auth/git/callback?provider=test',
      scope: 'read write',
      subject: 'oidc:alice',
      host: 'provider.example',
    })
    expect(url).toContain('https://provider.example/oauth/authorize?')
    expect(url).toContain('client_id=client-1')
    expect(url).toContain(`state=${state}`)

    const pending = flow.consumePending(state)
    expect(pending).toEqual({ subject: 'oidc:alice', host: 'provider.example', createdAt: expect.any(Number) })
  })

  it('consumePending is single-use', () => {
    const { state } = flow.beginAuthorize({ authorizeUrl: 'https://p/authorize', clientId: 'c', redirectUri: 'https://s/cb', scope: '', subject: 's', host: 'h' })
    expect(flow.consumePending(state)).not.toBeNull()
    expect(flow.consumePending(state)).toBeNull()
  })

  it('consumePending returns null for an unknown state', () => {
    expect(flow.consumePending('never-issued')).toBeNull()
  })
})

describe('OAuthCodeFlow: exchangeCode', () => {
  it('posts the authorization_code grant and returns the parsed tokens', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
    const result = await flow.exchangeCode({ tokenUrl: 'https://p/token', clientId: 'c', clientSecret: 'secret', redirectUri: 'https://s/cb', code: 'auth-code' })
    expect(result?.accessToken).toBe('AT')
    expect(result?.refreshToken).toBe('RT')
    expect(result?.expiresAt).toBeGreaterThan(Date.now())

    const [, init] = fetchMock.mock.calls[0]
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('client_secret')).toBe('secret')
  })

  it('returns null when the token endpoint responds with an error status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }))
    const result = await flow.exchangeCode({ tokenUrl: 'https://p/token', clientId: 'c', clientSecret: 's', redirectUri: 'https://s/cb', code: 'bad' })
    expect(result).toBeNull()
  })

  it('returns null when the response has no access_token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}))
    expect(await flow.exchangeCode({ tokenUrl: 'https://p/token', clientId: 'c', clientSecret: 's', redirectUri: 'https://s/cb', code: 'x' })).toBeNull()
  })

  it('returns null when the fetch itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    expect(await flow.exchangeCode({ tokenUrl: 'https://p/token', clientId: 'c', clientSecret: 's', redirectUri: 'https://s/cb', code: 'x' })).toBeNull()
  })
})

describe('OAuthCodeFlow: refresh', () => {
  it('posts the refresh_token grant', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'AT2', expires_in: 60 }))
    const result = await flow.refresh({ tokenUrl: 'https://p/token', clientId: 'c', clientSecret: 's', refreshToken: 'RT' })
    expect(result?.accessToken).toBe('AT2')
    const [, init] = fetchMock.mock.calls[0]
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
  })
})
