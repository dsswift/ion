/**
 * Sign-ins a client finishes on its own device: the URL goes back to a phone
 * instead of a broadcast, an MCP login can hand its redirect to the engine
 * and wait for the landing address, and `completeSignIn` routes that address
 * to the right exchange once, within its time limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  request: vi.fn(),
  broadcast: vi.fn(),
  storeTokens: vi.fn(async () => {}),
  fetch: vi.fn(),
}))
vi.mock('../../state', () => ({ engineBridge: { request: deps.request } }))
vi.mock('../../broadcast', () => ({ broadcast: deps.broadcast }))
vi.mock('../token-store', () => ({ storeTokens: deps.storeTokens }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { openAuthUrl, setAuthUrlOpener, broadcastAuthUrlOpener } from '../url-opener'
import { registerPendingSignIn, lookupPendingSignIn, PENDING_SIGN_IN_TTL_MS, _resetPendingSignInsForTest } from '../pending-sign-ins'
import { completeSignIn } from '../complete-sign-in'
import { beginGoogleRemoteLogin } from '../providers'
import { loginServer } from '../../mcp-admin'
import { beginDeviceSignIn } from '../entra-flow'
import type { Connection } from '../../protocol/connection'

const phone = { id: 'c-phone', view: 'thin', transport: 'relay' } as unknown as Connection
const desktop = { id: 'c-desk', view: 'mirror', transport: 'local' } as unknown as Connection

beforeEach(() => {
  deps.request.mockReset()
  deps.broadcast.mockReset()
  deps.storeTokens.mockClear()
  deps.fetch.mockReset()
  vi.stubGlobal('fetch', deps.fetch)
  _resetPendingSignInsForTest()
  setAuthUrlOpener(broadcastAuthUrlOpener)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openAuthUrl', () => {
  it('broadcasts for a mirror requester or an unknown one, and never for a thin requester', async () => {
    await openAuthUrl('https://idp.example.org/a', desktop)
    await openAuthUrl('https://idp.example.org/b')
    await openAuthUrl('https://idp.example.org/c', phone)
    expect(deps.broadcast.mock.calls).toEqual([
      ['ion:open-auth-url', { url: 'https://idp.example.org/a' }],
      ['ion:open-auth-url', { url: 'https://idp.example.org/b' }],
    ])
  })
})

describe('pending sign-ins', () => {
  it('expire after the time limit, and a newer sign-in for the same target replaces the older', () => {
    const first = registerPendingSignIn({ kind: 'mcp', mcpName: 'linear' }, 1_000)
    const other = registerPendingSignIn({ kind: 'mcp', mcpName: 'notion' }, 1_000)
    const second = registerPendingSignIn({ kind: 'mcp', mcpName: 'linear' }, 2_000)
    expect(lookupPendingSignIn(first, 2_000)).toEqual({ ok: false, reason: 'unknown' })
    expect(lookupPendingSignIn(other, 2_000)).toEqual({ ok: true, flow: { kind: 'mcp', mcpName: 'notion' } })
    expect(lookupPendingSignIn(second, 2_000 + PENDING_SIGN_IN_TTL_MS)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('mcp login with a redirect', () => {
  it('hands the redirect to the engine, opens nothing, and returns the URL with a flow id', async () => {
    deps.request.mockResolvedValue({ ok: true, data: { authorizationUrl: 'https://mcp.example.org/authorize?x=1' } })
    const result = await loginServer('linear', undefined, { requester: phone, redirectUri: 'ion://mcp-callback' })
    expect(deps.request).toHaveBeenCalledWith('mcp_login', { mcpName: 'linear', mcpRedirectUri: 'ion://mcp-callback' })
    expect(result.authorizationUrl).toBe('https://mcp.example.org/authorize?x=1')
    expect(lookupPendingSignIn(result.flowId!)).toEqual({ ok: true, flow: { kind: 'mcp', mcpName: 'linear' } })
    expect(deps.broadcast).not.toHaveBeenCalled()
  })
})

describe('completeSignIn', () => {
  it('routes an MCP flow to the engine with the landing address, once', async () => {
    const flowId = registerPendingSignIn({ kind: 'mcp', mcpName: 'linear' })
    deps.request.mockResolvedValue({ ok: true })
    await completeSignIn(flowId, 'ion://mcp-callback?code=c&state=s')
    expect(deps.request).toHaveBeenCalledWith('mcp_login_complete', { mcpName: 'linear', mcpCallbackUrl: 'ion://mcp-callback?code=c&state=s' })
    await expect(completeSignIn(flowId, 'ion://mcp-callback?code=c&state=s')).rejects.toThrow(/No sign-in is waiting/)
  })

  it('surfaces the engine refusal and keeps the flow for another try', async () => {
    const flowId = registerPendingSignIn({ kind: 'mcp', mcpName: 'linear' })
    deps.request.mockResolvedValue({ ok: false, error: 'state mismatch' })
    await expect(completeSignIn(flowId, 'ion://mcp-callback?code=c&state=bad')).rejects.toThrow('state mismatch')
    expect(lookupPendingSignIn(flowId).ok).toBe(true)
  })

  it('says an expired flow expired', async () => {
    const flowId = registerPendingSignIn({ kind: 'mcp', mcpName: 'linear' }, Date.now() - PENDING_SIGN_IN_TTL_MS - 1)
    await expect(completeSignIn(flowId, 'ion://x')).rejects.toThrow(/expired/)
  })

  it('exchanges a Google landing address and stores the tokens', async () => {
    const begun = beginGoogleRemoteLogin()
    expect(new URL(begun.authorizationUrl).searchParams.get('state')).toBe(begun.state)
    const flowId = registerPendingSignIn({ kind: 'google', verifier: begun.verifier, state: begun.state })
    deps.fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }) })
    await completeSignIn(flowId, `http://localhost:8085/oauth2callback?state=${begun.state}&code=the-code`)
    const body = (deps.fetch.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe(begun.verifier)
    expect(deps.storeTokens).toHaveBeenCalledWith('google', 'at', 'rt', expect.any(Number))
  })

  it('refuses a Google address from another sign-in or one the provider refused, without exchanging', async () => {
    const begun = beginGoogleRemoteLogin()
    const flowId = registerPendingSignIn({ kind: 'google', verifier: begun.verifier, state: begun.state })
    await expect(completeSignIn(flowId, 'http://localhost:8085/oauth2callback?state=other&code=c')).rejects.toThrow(/different sign-in/)
    await expect(completeSignIn(flowId, 'http://localhost:8085/oauth2callback?error=access_denied')).rejects.toThrow(/access_denied/)
    await expect(completeSignIn(flowId, 'not a url')).rejects.toThrow(/not the address/)
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(deps.storeTokens).not.toHaveBeenCalled()
  })
})

describe('entra device sign-in', () => {
  it('asks the engine for the device branch, returns the code, and waits in the background until the identity lands', async () => {
    vi.useFakeTimers()
    try {
      deps.request.mockImplementation(async (cmd: string) => {
        if (cmd === 'oidc_begin_login') return { ok: true, data: { userCode: 'ABCD', verificationUri: 'https://login.example.org/device', expiresIn: 900 } }
        return { ok: true, data: { signedIn: deps.request.mock.calls.length > 2, subject: 'oid' } }
      })
      expect(await beginDeviceSignIn()).toEqual({ userCode: 'ABCD', verificationUri: 'https://login.example.org/device', expiresIn: 900 })
      expect(deps.request).toHaveBeenCalledWith('oidc_begin_login', { oidcFlow: 'device' })
      await vi.advanceTimersByTimeAsync(10_000)
      // Polls stop once the identity is signed in.
      expect(deps.request.mock.calls.filter(([cmd]) => cmd === 'oidc_identity')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with the engine error when no device code comes back', async () => {
    deps.request.mockResolvedValue({ ok: false, error: 'no OIDC identity provider configured' })
    await expect(beginDeviceSignIn()).rejects.toThrow('no OIDC identity provider configured')
  })
})
