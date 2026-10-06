import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

const refresh = vi.hoisted(() => ({ refreshForScope: vi.fn() }))
vi.mock('../../auth/browser-oidc', () => refresh)

import type { ServerOidcConfig } from '../../config/server-config'
import type { ServerSubscriptionLookupConfig } from '../../config/subscription-lookup-config'
import type { BrowserSessionRecord, BrowserSessionStore, SessionTokenUpdate } from '../../auth/browser-session-store'
import { sessionTokenProvider } from '../session-token-provider'

const OIDC = { issuer: 'https://login.example/v2.0', audience: 'server-app', scope: 'Studio.Access', clientId: 'server-app', rolesToScopes: {}, defaultScopes: [], allowedSubjects: [], clientSecret: '' } as ServerOidcConfig
const LOOKUP: ServerSubscriptionLookupConfig = {
  endpoint: 'https://ai.example.org/keys/subscriptions', provider: 'gateway', scope: 'api://dci-orion/Gateway.Keys.Read',
  displayName: '', header: '', timeoutMs: 1000, cacheMaxAgeSeconds: 0, requireSelection: false,
}

function sessionsFor(subject: string | null, refreshToken: string | null = 'refresh-1') {
  const updates: SessionTokenUpdate[] = []
  const store = {
    mostRecentSessionFor: (s: string): BrowserSessionRecord | undefined => (subject === s ? { sessionId: 'sid', accessExpiresAt: 123 } as BrowserSessionRecord : undefined),
    tokensFor: () => ({ accessToken: 'session-access', refreshToken }),
    updateTokens: (_id: string, update: SessionTokenUpdate) => { updates.push(update); return true },
  } as unknown as BrowserSessionStore
  return { store, updates }
}

beforeEach(() => refresh.refreshForScope.mockReset())

describe('the lookup token', () => {
  it('is minted for the lookup scope from the person\'s own browser session', async () => {
    refresh.refreshForScope.mockResolvedValue({ ok: true, accessToken: 'gateway-token', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-1' })
    const { store } = sessionsFor('alice')
    const result = await sessionTokenProvider(() => OIDC, () => LOOKUP, store)('alice')
    expect(result).toEqual({ ok: true, accessToken: 'gateway-token' })
    expect(refresh.refreshForScope).toHaveBeenCalledWith(OIDC, 'refresh-1', 'api://dci-orion/Gateway.Keys.Read')
  })

  it('says so when the person has never signed in through a browser', async () => {
    const { store } = sessionsFor(null)
    const result = await sessionTokenProvider(() => OIDC, () => LOOKUP, store)('alice')
    expect(result).toEqual({ ok: false, reason: 'you have not signed in to this server in a browser' })
    expect(refresh.refreshForScope).not.toHaveBeenCalled()
  })

  it('never uses another person\'s session', async () => {
    const { store } = sessionsFor('bob')
    expect((await sessionTokenProvider(() => OIDC, () => LOOKUP, store)('alice')).ok).toBe(false)
  })

  it('says so when the session holds no refresh token', async () => {
    const { store } = sessionsFor('alice', null)
    const result = await sessionTokenProvider(() => OIDC, () => LOOKUP, store)('alice')
    expect(result).toEqual({ ok: false, reason: 'your sign-in cannot be renewed; sign in again' })
  })

  it('passes the identity provider\'s reason through, such as missing consent', async () => {
    refresh.refreshForScope.mockResolvedValue({ ok: false, reason: 'this app has not been given access to the key lookup yet; an administrator must grant consent' })
    const { store } = sessionsFor('alice')
    const result = await sessionTokenProvider(() => OIDC, () => LOOKUP, store)('alice')
    expect(result).toEqual({ ok: false, reason: 'this app has not been given access to the key lookup yet; an administrator must grant consent' })
  })

  it('keeps a rotated refresh token and leaves the session\'s own access token alone', async () => {
    refresh.refreshForScope.mockResolvedValue({ ok: true, accessToken: 'g', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-2' })
    const { store, updates } = sessionsFor('alice')
    await sessionTokenProvider(() => OIDC, () => LOOKUP, store)('alice')
    expect(updates).toEqual([{ accessToken: 'session-access', refreshToken: 'refresh-2', accessExpiresAt: 123 }])
  })

  it('reuses a fresh token without calling the identity provider again', async () => {
    refresh.refreshForScope.mockResolvedValue({ ok: true, accessToken: 'g', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-1' })
    const { store } = sessionsFor('alice')
    const provider = sessionTokenProvider(() => OIDC, () => LOOKUP, store)
    await provider('alice')
    await provider('alice')
    expect(refresh.refreshForScope).toHaveBeenCalledTimes(1)
  })

  it('has nothing to mint without a sign-in or a lookup configured', async () => {
    const { store } = sessionsFor('alice')
    expect((await sessionTokenProvider(() => null, () => LOOKUP, store)('alice')).ok).toBe(false)
    expect((await sessionTokenProvider(() => OIDC, () => null, store)('alice')).ok).toBe(false)
  })
})
