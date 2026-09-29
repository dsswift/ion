/**
 * signInFromThisMachine: a sign-in for an MCP server on another machine opens
 * the page here, catches the redirect here, and hands the landing address to
 * the server. Every early exit stops the local listener.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))

const { signInFromThisMachine } = await import('../integrations/mcp-remote-sign-in')

const redirectUri = 'http://127.0.0.1:50123/callback'
function makeShell() {
  return {
    oauthCallbackListen: vi.fn(async () => ({ id: 'cb-1', redirectUri })),
    oauthCallbackAwait: vi.fn(async () => `${redirectUri}?code=c&state=s`),
    oauthCallbackCancel: vi.fn(async () => {}),
    mcpLogin: vi.fn(async (): Promise<{ ok: boolean; authorizationUrl?: string; flowId?: string; error?: string }> => ({ ok: true, authorizationUrl: 'https://login.example.test/authorize', flowId: 'flow-1' })),
    authCompleteSignIn: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  }
}

let shell = makeShell()
const openUrl = vi.fn(async () => true)
beforeEach(() => {
  shell = makeShell()
  openUrl.mockReset().mockResolvedValue(true)
})

describe('signInFromThisMachine', () => {
  it('starts a caller-finished sign-in with the local redirect and returns the landing address', async () => {
    await expect(signInFromThisMachine(shell, openUrl, 'exchange')).resolves.toEqual({ ok: true })
    expect(shell.mcpLogin).toHaveBeenCalledWith('exchange', undefined, { redirectUri })
    expect(openUrl).toHaveBeenCalledWith('https://login.example.test/authorize')
    expect(shell.authCompleteSignIn).toHaveBeenCalledWith({ flowId: 'flow-1', callbackUrl: `${redirectUri}?code=c&state=s` })
  })

  it('stops the listener when the server refuses to start', async () => {
    shell.mcpLogin.mockResolvedValue({ ok: false, error: 'discovery failed' })
    await expect(signInFromThisMachine(shell, openUrl, 'exchange')).resolves.toEqual({ ok: false, error: 'discovery failed' })
    expect(shell.oauthCallbackCancel).toHaveBeenCalledWith('cb-1')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('stops the listener when the browser does not open', async () => {
    openUrl.mockResolvedValue(false)
    const result = await signInFromThisMachine(shell, openUrl, 'exchange')
    expect(result.ok).toBe(false)
    expect(shell.oauthCallbackCancel).toHaveBeenCalledWith('cb-1')
    expect(shell.authCompleteSignIn).not.toHaveBeenCalled()
  })

  it('reports the server refusing the landing address', async () => {
    shell.authCompleteSignIn.mockResolvedValue({ ok: false, error: 'state mismatch' })
    await expect(signInFromThisMachine(shell, openUrl, 'exchange')).resolves.toEqual({ ok: false, error: 'state mismatch' })
  })
})
