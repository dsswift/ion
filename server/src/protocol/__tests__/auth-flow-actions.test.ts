/**
 * The `oauth.*` / `entra.*` / `mcp.*` / `auth.completeSignIn` wire faces of
 * sign-ins a phone can finish: each action names its requester, returns what
 * the requester must open or enter, and routes the landing address back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  loginGoogle: vi.fn(),
  beginGoogleRemoteLogin: vi.fn(() => ({ authorizationUrl: 'https://accounts.example.org/auth?state=s', verifier: 'v', state: 's' })),
  storeTokens: vi.fn(async () => {}),
  entraSignIn: vi.fn(),
  entraBeginDeviceSignIn: vi.fn(async () => ({ userCode: 'ABCD-EFGH', verificationUri: 'https://login.example.org/device', expiresIn: 900 })),
  loginServer: vi.fn(async () => ({ authorizationUrl: 'https://mcp.example.org/authorize', flowId: 'flow-1' })),
  completeSignIn: vi.fn(async () => {}),
  updateServer: vi.fn(),
}))
vi.mock('../../oauth', () => ({
  loginGoogle: deps.loginGoogle,
  beginGoogleRemoteLogin: deps.beginGoogleRemoteLogin,
  startGitHubDeviceFlow: vi.fn(),
  pollGitHubAccessToken: vi.fn(),
  exchangeGitHubForCopilotToken: vi.fn(),
  storeTokens: deps.storeTokens,
  clearTokens: vi.fn(),
}))
vi.mock('../../oauth/entra-flow', () => ({
  signIn: deps.entraSignIn,
  beginDeviceSignIn: deps.entraBeginDeviceSignIn,
  signOut: vi.fn(),
  getSignedInIdentity: vi.fn(),
  getOperatorIdentityState: vi.fn(),
  getAccessToken: vi.fn(),
}))
vi.mock('../../mcp-admin', () => ({ addServer: vi.fn(), listServers: vi.fn(), loginServer: deps.loginServer, logoutServer: vi.fn(), removeServer: vi.fn(), updateServer: deps.updateServer }))
vi.mock('../../oauth/complete-sign-in', () => ({ completeSignIn: deps.completeSignIn }))
vi.mock('../lifecycle-actions', () => ({ isLocalDesktop: () => false }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { AUTH_FLOW_ACTIONS } from '../auth-flow-actions'
import type { Connection } from '../connection'

const phone = { id: 'c-phone', view: 'thin', transport: 'relay', scopes: ['admin'] } as unknown as Connection
const desktop = { id: 'c-desk', view: 'mirror', transport: 'local', scopes: ['admin'] } as unknown as Connection

const run = (name: string, conn: Connection, args: unknown[]) => AUTH_FLOW_ACTIONS[name].handler(conn, args)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('oauth.start for Google', () => {
  it('hands an off-host requester the page and a flow id, and starts no loopback listener', async () => {
    const outcome = await run('oauth.start', phone, [{ provider: 'google' }])
    expect(outcome).toEqual({ ok: true, value: { ok: true, authorizationUrl: 'https://accounts.example.org/auth?state=s', flowId: expect.any(String) } })
    expect(deps.loginGoogle).not.toHaveBeenCalled()
  })

  it('finishes on the host through the loopback listener and returns the page it opened', async () => {
    deps.loginGoogle.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1, authorizationUrl: 'https://accounts.example.org/auth' })
    const outcome = await run('oauth.start', desktop, [{ provider: 'google' }])
    expect(deps.loginGoogle).toHaveBeenCalledWith(desktop)
    expect(deps.storeTokens).toHaveBeenCalledWith('google', 'at', 'rt', 1)
    expect(outcome).toEqual({ ok: true, value: { ok: true, authorizationUrl: 'https://accounts.example.org/auth' } })
  })
})

describe('entra.signIn', () => {
  it('answers a device request with the code to enter', async () => {
    const outcome = await run('entra.signIn', phone, [{ flow: 'device' }])
    expect(outcome).toEqual({ ok: true, value: { ok: true, userCode: 'ABCD-EFGH', verificationUri: 'https://login.example.org/device', expiresIn: 900 } })
    expect(deps.entraSignIn).not.toHaveBeenCalled()
  })

  it('runs the browser flow for its requester by default and returns the page', async () => {
    deps.entraSignIn.mockResolvedValue({ identity: { user: 'user@example.com' }, authorizationUrl: 'https://login.example.org/authorize' })
    const outcome = await run('entra.signIn', desktop, [])
    expect(deps.entraSignIn).toHaveBeenCalledWith(desktop)
    expect(outcome).toEqual({ ok: true, value: { ok: true, identity: { user: 'user@example.com' }, authorizationUrl: 'https://login.example.org/authorize' } })
  })
})

describe('mcp.update', () => {
  it('passes the request through and returns the outcome', async () => {
    deps.updateServer.mockResolvedValue({ changed: true, credentialsCleared: true })
    const outcome = await run('mcp.update', phone, [{ name: 'exchange', oauth: { clientId: 'client-2' } }])
    expect(deps.updateServer).toHaveBeenCalledWith({ name: 'exchange', oauth: { clientId: 'client-2' } })
    expect(outcome).toEqual({ ok: true, value: { ok: true, changed: true, credentialsCleared: true } })
  })

  it('returns the engine refusal', async () => {
    deps.updateServer.mockRejectedValue(new Error('MCP server "ghost" is not configured'))
    const outcome = await run('mcp.update', phone, [{ name: 'ghost' }])
    expect(outcome).toEqual({ ok: true, value: { ok: false, error: 'MCP server "ghost" is not configured' } })
  })
})

describe('mcp.login', () => {
  it('passes the requester and the redirect, and returns the page and flow id', async () => {
    const outcome = await run('mcp.login', phone, ['linear', null, { redirectUri: 'ion://mcp-callback' }])
    expect(deps.loginServer).toHaveBeenCalledWith('linear', undefined, { requester: phone, redirectUri: 'ion://mcp-callback' })
    expect(outcome).toEqual({ ok: true, value: { ok: true, authorizationUrl: 'https://mcp.example.org/authorize', flowId: 'flow-1' } })
  })

  it('keeps the loopback flow when no redirect is given', async () => {
    await run('mcp.login', desktop, ['linear', 'read'])
    expect(deps.loginServer).toHaveBeenCalledWith('linear', 'read', { requester: desktop, redirectUri: undefined })
  })
})

describe('auth.completeSignIn', () => {
  it('is admin, and reports a completion failure as a readable error', async () => {
    expect(AUTH_FLOW_ACTIONS['auth.completeSignIn'].requiredScope).toBe('admin')
    expect(await run('auth.completeSignIn', phone, [{ flowId: 'f', callbackUrl: 'ion://cb?code=c' }])).toEqual({ ok: true, value: { ok: true } })
    expect(deps.completeSignIn).toHaveBeenCalledWith('f', 'ion://cb?code=c')
    deps.completeSignIn.mockRejectedValueOnce(new Error('That sign-in expired. Start it again.'))
    expect(await run('auth.completeSignIn', phone, [{ flowId: 'f', callbackUrl: 'x' }])).toEqual({ ok: true, value: { ok: false, error: 'That sign-in expired. Start it again.' } })
  })
})
