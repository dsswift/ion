import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BrowserSessionStore, newSessionId } from '../browser-session-store'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'

let dir: string
let store: BrowserSessionStore

const principal: StudioPrincipalSummary = { subject: 'josh', displayName: 'Josh', provider: 'entra', kind: 'operator' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-browser-session-store-test-'))
  store = new BrowserSessionStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('BrowserSessionStore', () => {
  it('starts empty when browser-sessions.json is absent', () => {
    expect(store.get('anything')).toBeUndefined()
  })

  it('round-trips a created session and decrypts its tokens back to the originals', () => {
    const sessionId = newSessionId()
    const record = store.create({
      sessionId,
      principal,
      scopes: ['conversations:read'],
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      accessExpiresAt: Date.now() + 3600_000,
    })
    expect(record.sessionId).toBe(sessionId)

    const reloaded = new BrowserSessionStore(dir)
    const found = reloaded.get(sessionId)
    expect(found).toBeDefined()
    expect(found?.principal.subject).toBe('josh')

    const tokens = reloaded.tokensFor(sessionId)
    expect(tokens?.accessToken).toBe('access-token-value')
    expect(tokens?.refreshToken).toBe('refresh-token-value')
  })

  it('never writes plaintext tokens to disk', () => {
    const sessionId = newSessionId()
    store.create({
      sessionId,
      principal,
      scopes: [],
      accessToken: 'super-secret-access-token',
      refreshToken: 'super-secret-refresh-token',
      accessExpiresAt: Date.now() + 3600_000,
    })
    const raw = readFileSync(join(dir, 'browser-sessions.json'), 'utf-8')
    expect(raw).not.toContain('super-secret-access-token')
    expect(raw).not.toContain('super-secret-refresh-token')
  })

  it('handles a session with no refresh token', () => {
    const sessionId = newSessionId()
    store.create({ sessionId, principal, scopes: [], accessToken: 'access-only', refreshToken: null, accessExpiresAt: Date.now() + 1000 })
    const tokens = store.tokensFor(sessionId)
    expect(tokens?.accessToken).toBe('access-only')
    expect(tokens?.refreshToken).toBeNull()
  })

  it('touch updates lastSeenAt', async () => {
    const sessionId = newSessionId()
    const before = store.create({ sessionId, principal, scopes: [], accessToken: 'a', refreshToken: null, accessExpiresAt: 0 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.touch(sessionId)
    const after = store.get(sessionId)
    expect(after!.lastSeenAt).toBeGreaterThan(before.lastSeenAt)
  })

  it('touch on an unknown sessionId is a no-op, not an error', () => {
    expect(() => store.touch('no-such-session')).not.toThrow()
  })

  it('updateTokens rotates tokens and expiry', () => {
    const sessionId = newSessionId()
    store.create({ sessionId, principal, scopes: [], accessToken: 'old-access', refreshToken: 'old-refresh', accessExpiresAt: 1 })
    const ok = store.updateTokens(sessionId, { accessToken: 'new-access', refreshToken: 'new-refresh', accessExpiresAt: 999 })
    expect(ok).toBe(true)
    const found = store.get(sessionId)
    expect(found?.accessExpiresAt).toBe(999)
    expect(store.tokensFor(sessionId)?.accessToken).toBe('new-access')
    expect(store.tokensFor(sessionId)?.refreshToken).toBe('new-refresh')
  })

  it('updateTokens returns false for an unknown sessionId', () => {
    expect(store.updateTokens('no-such-session', { accessToken: 'x', refreshToken: null, accessExpiresAt: 0 })).toBe(false)
  })

  it('delete removes the session; delete is idempotent', () => {
    const sessionId = newSessionId()
    store.create({ sessionId, principal, scopes: [], accessToken: 'a', refreshToken: null, accessExpiresAt: 0 })
    store.delete(sessionId)
    expect(store.get(sessionId)).toBeUndefined()
    expect(() => store.delete(sessionId)).not.toThrow()
  })

  it('tokensFor returns null for an unknown sessionId', () => {
    expect(store.tokensFor('no-such-session')).toBeNull()
  })

  it('malformed browser-sessions.json is treated as an empty registry rather than throwing', () => {
    writeFileSync(join(dir, 'browser-sessions.json'), '{ not json')
    expect(store.get('anything')).toBeUndefined()
  })

  it('newSessionId produces distinct, URL-safe ids', () => {
    const a = newSessionId()
    const b = newSessionId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('mostRecentSessionFor returns undefined when the subject has no session', () => {
    expect(store.mostRecentSessionFor('josh')).toBeUndefined()
  })

  it('mostRecentSessionFor picks the freshest lastSeenAt among several sessions for the same subject', () => {
    vi.useFakeTimers()
    try {
      const older = newSessionId()
      const newer = newSessionId()
      vi.setSystemTime(1_000)
      store.create({ sessionId: older, principal, scopes: [], accessToken: 'a1', refreshToken: null, accessExpiresAt: 0 })
      vi.setSystemTime(2_000)
      store.create({ sessionId: newer, principal, scopes: [], accessToken: 'a2', refreshToken: null, accessExpiresAt: 0 })

      const found = store.mostRecentSessionFor('josh')
      expect(found?.sessionId).toBe(newer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('mostRecentSessionFor never returns a different subjects session', () => {
    const bob: StudioPrincipalSummary = { subject: 'bob', displayName: 'Bob' }
    store.create({ sessionId: newSessionId(), principal: bob, scopes: [], accessToken: 'a', refreshToken: null, accessExpiresAt: 0 })
    expect(store.mostRecentSessionFor('josh')).toBeUndefined()
  })
})
