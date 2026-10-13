import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { refreshAccessToken } = vi.hoisted(() => ({ refreshAccessToken: vi.fn() }))
vi.mock('../browser-oidc', () => ({ refreshAccessToken }))

import { authenticateSession } from '../session-auth'
import { TEMPORARILY_UNAVAILABLE } from '../../protocol/hello'
import { BrowserSessionStore } from '../browser-session-store'
import type { ServerOidcConfig } from '../../config/server-config'

const OIDC = { issuer: 'https://login.example.test/t', audience: 'a', scope: 's', clientId: 'c', rolesToScopes: {}, defaultScopes: [], allowedSubjects: [], clientSecret: '' } as ServerOidcConfig
const principal = { subject: 'josh', displayName: 'Josh' }

let dir: string
let store: BrowserSessionStore
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-session-auth-')); store = new BrowserSessionStore(dir); refreshAccessToken.mockReset() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A session whose access token has expired (overnight), so using it needs a refresh. */
function expiredSession(): string {
  store.create({ sessionId: 'overnight', principal, scopes: ['conversations:read'], accessToken: 'old', refreshToken: 'refresh', accessExpiresAt: Date.now() - 3600_000 })
  return 'overnight'
}

describe('authenticateSession after the access token expired', () => {
  it('refreshes with the stored refresh token and keeps working, no sign-in', async () => {
    const id = expiredSession()
    refreshAccessToken.mockResolvedValueOnce({ ok: true, auth: { ok: true, principal, scopes: ['conversations:read'], expiresAt: Date.now() + 3600_000 }, accessToken: 'new', refreshToken: 'rotated' })

    const result = await authenticateSession(OIDC, store, id)

    expect(result.ok).toBe(true)
    expect(store.tokensFor(id)).toEqual({ accessToken: 'new', refreshToken: 'rotated' })
  })

  it('deletes the session and refuses when the provider refused the refresh token for good', async () => {
    const id = expiredSession()
    refreshAccessToken.mockResolvedValueOnce({ ok: false, transient: false })

    expect(await authenticateSession(OIDC, store, id)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(store.get(id)).toBeUndefined()
  })

  // The failure this pins: one minute of the provider being unreachable used to delete every session
  // that happened to need a refresh in that minute, signing people out for nothing.
  it('keeps the session, and says to try again, when the provider could not be reached', async () => {
    const id = expiredSession()
    refreshAccessToken.mockResolvedValueOnce({ ok: false, transient: true })

    expect(await authenticateSession(OIDC, store, id)).toEqual({ ok: false, reason: TEMPORARILY_UNAVAILABLE })
    expect(store.get(id)).toBeDefined()
    expect(store.tokensFor(id)?.refreshToken).toBe('refresh')
  })

  it('refuses a session it has never heard of, and a request with no cookie', async () => {
    expect(await authenticateSession(OIDC, store, 'forgotten')).toEqual({ ok: false, reason: 'unauthorized' })
    expect(await authenticateSession(OIDC, store, null)).toEqual({ ok: false, reason: 'unauthorized' })
  })
})
