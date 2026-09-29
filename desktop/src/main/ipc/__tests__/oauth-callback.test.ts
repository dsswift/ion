/**
 * oauth-callback: the listener that catches a sign-in redirect on this machine
 * for a server elsewhere. It returns the full landing address, answers only its
 * callback path, and gives up at its deadline or on cancel.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

const { listenForOAuthCallback, awaitOAuthCallback, cancelOAuthCallback } = await import('../oauth-callback')

describe('oauth-callback', () => {
  it('resolves with the full address the browser landed on', async () => {
    const { id, redirectUri } = await listenForOAuthCallback()
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const landed = awaitOAuthCallback(id)
    const res = await fetch(`${redirectUri}?code=abc&state=xyz`)
    expect(res.status).toBe(200)
    await expect(landed).resolves.toBe(`${redirectUri}?code=abc&state=xyz`)
    await expect(awaitOAuthCallback(id)).rejects.toThrow('no longer waiting')
  })

  it('answers only its callback path', async () => {
    const { id, redirectUri } = await listenForOAuthCallback()
    const res = await fetch(redirectUri.replace('/callback', '/favicon.ico'))
    expect(res.status).toBe(404)
    cancelOAuthCallback(id)
    await expect(awaitOAuthCallback(id)).rejects.toThrow('no longer waiting')
  })

  it('rejects when cancelled and when the deadline passes', async () => {
    const cancelled = await listenForOAuthCallback()
    const waiting = awaitOAuthCallback(cancelled.id)
    cancelOAuthCallback(cancelled.id)
    await expect(waiting).rejects.toThrow('cancelled')

    const late = await listenForOAuthCallback(20)
    await expect(awaitOAuthCallback(late.id)).rejects.toThrow('in time')
  })
})
