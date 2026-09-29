import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, createHmac } from 'crypto'

const { refreshAccessToken } = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
vi.mock('../browser-oidc', () => ({ refreshAccessToken }))

import { DefaultAuthPolicy } from '../auth-policy'
import { CredentialsStore } from '../credentials-store'
import { BrowserSessionStore, newSessionId } from '../browser-session-store'
import { _resetNonceForTest, currentNonce } from '../nonce'
import { startJwksFixture, signToken, type JwksFixture } from './jwks-fixture'
import { _resetBearerJwksCacheForTest } from '../bearer'
import type { ServerOidcConfig } from '../../config/server-config'

let dir: string
let store: CredentialsStore
let sessions: BrowserSessionStore
let fixture: JwksFixture

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ion-auth-policy-test-'))
  store = new CredentialsStore(dir)
  sessions = new BrowserSessionStore(dir)
  fixture = await startJwksFixture()
  _resetNonceForTest()
  refreshAccessToken.mockReset()
})

afterEach(async () => {
  _resetNonceForTest()
  _resetBearerJwksCacheForTest()
  await fixture.close()
  rmSync(dir, { recursive: true, force: true })
})

function oidcConfig(): ServerOidcConfig {
  return {
    issuer: fixture.issuer,
    audience: 'api://studio-server',
    scope: 'Studio.Access',
    clientId: '',
    rolesToScopes: { 'Studio.Admin': ['admin'] },
    defaultScopes: ['conversations:read'],
    allowedSubjects: [],
    clientSecret: '',
  }
}

function policyWith(oidc: ServerOidcConfig | null): DefaultAuthPolicy {
  return new DefaultAuthPolicy({ oidc, credentials: store, sessions })
}

describe('DefaultAuthPolicy: local', () => {
  it('accepts {kind:local} on the local transport with every scope', async () => {
    const policy = policyWith(null)
    const result = await policy.authenticate({ kind: 'local' }, 'local', null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toContain('admin')
  })

  it('refuses {kind:local} on the tcp transport', async () => {
    const policy = policyWith(null)
    const result = await policy.authenticate({ kind: 'local' }, 'tcp', null)
    expect(result.ok).toBe(false)
  })
})

describe('DefaultAuthPolicy: paired', () => {
  it('routes to paired.ts and accepts a valid proof', async () => {
    const secret = randomBytes(32)
    store.add({ clientId: 'client-1', secret, scopes: ['conversations:read'], subject: 'paired:client-1', kind: 'desktop' })
    const proof = createHmac('sha256', secret).update(Buffer.from(currentNonce(), 'base64url')).digest('base64')

    const policy = policyWith(null)
    const result = await policy.authenticate({ kind: 'paired', clientId: 'client-1', proof }, 'tcp', null)
    expect(result.ok).toBe(true)
  })
})

describe('DefaultAuthPolicy: bearer', () => {
  it('refuses every bearer credential when server.json has no oidc block', async () => {
    const policy = policyWith(null)
    const result = await policy.authenticate({ kind: 'bearer', token: 'anything' }, 'tcp', null)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('routes to bearer.ts and accepts a valid token when oidc is configured', async () => {
    const token = await signToken(fixture, { sub: 'user-1', aud: 'api://studio-server', scp: 'Studio.Access', roles: ['Studio.Admin'] })
    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'bearer', token }, 'tcp', null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toEqual(['admin'])
  })
})

describe('DefaultAuthPolicy: session', () => {
  it('refuses when the connection carries no session cookie', async () => {
    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', null)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('refuses when server.json has no oidc block', async () => {
    const sessionId = newSessionId()
    sessions.create({ sessionId, principal: { subject: 'josh', displayName: 'Josh' }, scopes: ['conversations:read'], accessToken: 'a', refreshToken: null, accessExpiresAt: Date.now() + 3600_000 })
    const policy = policyWith(null)
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', sessionId)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('refuses an unknown session cookie', async () => {
    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', 'not-a-real-session')
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('accepts a session whose access token is not near expiry, with no refresh attempted', async () => {
    const sessionId = newSessionId()
    sessions.create({
      sessionId,
      principal: { subject: 'josh', displayName: 'Josh' },
      scopes: ['conversations:read'],
      accessToken: 'a',
      refreshToken: 'r',
      accessExpiresAt: Date.now() + 3600_000,
    })
    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', sessionId)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.principal.subject).toBe('josh')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes a near-expiry session and accepts, persisting the rotated tokens', async () => {
    const sessionId = newSessionId()
    sessions.create({
      sessionId,
      principal: { subject: 'josh', displayName: 'Josh' },
      scopes: ['conversations:read'],
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accessExpiresAt: Date.now() + 1000, // well within the refresh lead window
    })
    refreshAccessToken.mockResolvedValueOnce({
      ok: true,
      auth: { ok: true, principal: { subject: 'josh', displayName: 'Josh' }, scopes: ['conversations:read', 'admin'], expiresAt: Date.now() + 3600_000 },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    })

    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', sessionId)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scopes).toEqual(['conversations:read', 'admin'])
    expect(refreshAccessToken).toHaveBeenCalledWith(expect.objectContaining({ issuer: fixture.issuer }), 'old-refresh')

    const stored = sessions.tokensFor(sessionId)
    expect(stored?.accessToken).toBe('new-access')
    expect(stored?.refreshToken).toBe('new-refresh')
  })

  it('deletes the session and refuses when refresh fails', async () => {
    const sessionId = newSessionId()
    sessions.create({
      sessionId,
      principal: { subject: 'josh', displayName: 'Josh' },
      scopes: [],
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accessExpiresAt: Date.now() + 1000,
    })
    refreshAccessToken.mockResolvedValueOnce({ ok: false })

    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', sessionId)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
    expect(sessions.get(sessionId)).toBeUndefined()
  })

  it('deletes the session and refuses when near expiry with no refresh token at all', async () => {
    const sessionId = newSessionId()
    sessions.create({
      sessionId,
      principal: { subject: 'josh', displayName: 'Josh' },
      scopes: [],
      accessToken: 'old-access',
      refreshToken: null,
      accessExpiresAt: Date.now() + 1000,
    })
    const policy = policyWith(oidcConfig())
    const result = await policy.authenticate({ kind: 'session' }, 'tcp', sessionId)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
    expect(sessions.get(sessionId)).toBeUndefined()
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })
})
