/**
 * OAuth IPC handler regression tests. After removing the broken OpenAI ChatGPT
 * OAuth flow (which stored a ChatGPT token as an OpenAI API key), OAUTH_START
 * must reject 'openai' with an unknown-provider error while Google and GitHub
 * Copilot continue to route. Handlers are captured from a mocked ipcMain and
 * invoked directly.
 */
import { describe, it, expect, vi } from 'vitest'

const { handlers, loginGoogleMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  loginGoogleMock: vi.fn(async () => ({ accessToken: 'g', refreshToken: 'r', expiresAt: Date.now() + 3600_000 })),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn(),
  },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../oauth', () => ({
  loginGoogle: loginGoogleMock,
  refreshGoogle: vi.fn(),
  startGitHubDeviceFlow: vi.fn(),
  pollGitHubAccessToken: vi.fn(),
  exchangeGitHubForCopilotToken: vi.fn(),
  refreshGitHubCopilot: vi.fn(),
  storeTokens: vi.fn(async () => {}),
  clearTokens: vi.fn(async () => {}),
  hasTokens: vi.fn(() => false),
  registerRefreshFn: vi.fn(),
}))
vi.mock('../../oauth/entra-auth', () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  getSignedInIdentity: vi.fn(async () => null),
}))

import { registerOAuthIpc } from '../oauth'
import { IPC } from '../../../shared/types'

registerOAuthIpc()

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

describe('OAUTH_START provider routing', () => {
  it('rejects openai with an unknown-provider error (no ChatGPT OAuth flow)', async () => {
    const res = (await invoke(IPC.OAUTH_START, { provider: 'openai' })) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toMatch(/unknown oauth provider/i)
    expect(loginGoogleMock).not.toHaveBeenCalled()
  })

  it('still routes google through its OAuth flow', async () => {
    const res = (await invoke(IPC.OAUTH_START, { provider: 'google' })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(loginGoogleMock).toHaveBeenCalledTimes(1)
  })
})
