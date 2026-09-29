// @vitest-environment jsdom
/**
 * Signing in from Studio: the sign-in page must reach the person, and the
 * call must wait as long as the person is given to finish it.
 *
 * Both failed in the desktop app. The page was opened with `window.open`,
 * which the desktop window refuses outright, so no browser appeared. And the
 * call waited the default 30 seconds while the server waits minutes for the
 * person, so Studio reported a timeout over a sign-in still in progress.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const hostMock = vi.hoisted(() => ({
  listener: null as ((payload: { url?: unknown }) => void) | null,
  openExternal: vi.fn(async (_url: string) => true),
}))

vi.mock('../host-instance', () => ({
  host: {
    shell: { onOpenAuthUrl: (cb: (payload: { url?: unknown }) => void) => { hostMock.listener = cb; return () => {} } },
    openExternal: hostMock.openExternal,
  },
}))

import { initAuthUrlOpen } from '../auth-url-open'
import { SHELL_INVOKE } from '../browser-shell-bridge'

describe('the sign-in page', () => {
  beforeEach(() => hostMock.openExternal.mockClear())

  it('opens through the host, never as a pop-up the desktop window would refuse', () => {
    const popup = vi.spyOn(window, 'open')
    initAuthUrlOpen()
    hostMock.listener?.({ url: 'https://login.example.org/authorize?x=1' })
    expect(hostMock.openExternal).toHaveBeenCalledWith('https://login.example.org/authorize?x=1')
    expect(popup).not.toHaveBeenCalled()
  })
})

describe('an interactive sign-in call', () => {
  // The server waits up to five minutes for the engine's Entra login alone.
  const SERVER_ENTRA_WAIT_MS = 5 * 60_000

  it.each(['entraSignIn', 'startOAuth', 'oauthDevicePoll'])('%s outlasts the server\'s own wait for the person', (verb) => {
    expect(SHELL_INVOKE[verb]?.timeoutMs ?? 30_000).toBeGreaterThan(SERVER_ENTRA_WAIT_MS)
  })
})
