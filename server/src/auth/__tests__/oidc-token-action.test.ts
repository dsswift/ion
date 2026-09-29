import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AUTH_ACTIONS } from '../actions'
import { engineBridge } from '../../state'
import type { Connection } from '../../protocol/connection'

describe('AUTH_ACTIONS oidc.token', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards scope/audience to the engine oidc_token command and returns the token', async () => {
    const requestSpy = vi.spyOn(engineBridge, 'request').mockResolvedValue({
      ok: true,
      data: { accessToken: 'tok-123', expiresAt: 999 },
    } as never)

    const outcome = await AUTH_ACTIONS['oidc.token'].handler({} as Connection, [{ scope: 'my-scope', audience: 'my-aud' }])

    expect(requestSpy).toHaveBeenCalledWith('oidc_token', { oidcScope: 'my-scope', oidcAudience: 'my-aud' })
    expect(outcome).toEqual({ ok: true, value: { accessToken: 'tok-123', expiresAt: 999 } })
  })

  it('returns a typed failure when the engine reports no accessToken', async () => {
    vi.spyOn(engineBridge, 'request').mockResolvedValue({ ok: false, error: 'no grant' } as never)

    const outcome = await AUTH_ACTIONS['oidc.token'].handler({} as Connection, [{ scope: 'x' }])

    expect(outcome.ok).toBe(false)
    expect((outcome as { error?: { code: string } }).error?.code).toBe('oidc_token_failed')
  })

  it('catches a throwing engine request and returns a typed failure rather than propagating', async () => {
    vi.spyOn(engineBridge, 'request').mockRejectedValue(new Error('engine unreachable'))

    const outcome = await AUTH_ACTIONS['oidc.token'].handler({} as Connection, [{ scope: 'x' }])

    expect(outcome.ok).toBe(false)
    expect((outcome as { error?: { message: string } }).error?.message).toContain('engine unreachable')
  })

  it('requires conversations:read scope', () => {
    expect(AUTH_ACTIONS['oidc.token'].requiredScope).toBe('conversations:read')
  })
})

describe('AUTH_ACTIONS oidc.identity', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the issuer and subject the operator is signed in as', async () => {
    vi.spyOn(engineBridge, 'request').mockResolvedValue({
      ok: true,
      data: { signedIn: true, subject: 'oid-home', issuer: 'https://login.example.org/home-tenant/v2.0', username: 'user@example.com' },
    } as never)
    const outcome = await AUTH_ACTIONS['oidc.identity'].handler({} as Connection, [])
    expect(outcome).toEqual({ ok: true, value: { issuer: 'https://login.example.org/home-tenant/v2.0', subject: 'oid-home' } })
  })

  it('reports null when signed out, or when the engine names no issuer', async () => {
    const spy = vi.spyOn(engineBridge, 'request').mockResolvedValue({ ok: true, data: { signedIn: false } } as never)
    expect(await AUTH_ACTIONS['oidc.identity'].handler({} as Connection, [])).toEqual({ ok: true, value: null })
    spy.mockResolvedValue({ ok: true, data: { signedIn: true, subject: 'oid-home' } } as never)
    expect(await AUTH_ACTIONS['oidc.identity'].handler({} as Connection, [])).toEqual({ ok: true, value: null })
  })
})
