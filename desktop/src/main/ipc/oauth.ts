import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import {
  loginOpenAI, refreshOpenAI,
  loginGoogle, refreshGoogle,
  startGitHubDeviceFlow, pollGitHubAccessToken, exchangeGitHubForCopilotToken, refreshGitHubCopilot,
  storeTokens, clearTokens, hasTokens, registerRefreshFn,
} from '../oauth'

function log(msg: string): void { _log('oauth', msg) }

const activeFlows = new Map<string, AbortController>()

export function registerOAuthIpc(): void {
  registerRefreshFn('openai', async (rt) => refreshOpenAI(rt))
  registerRefreshFn('google', async (rt) => refreshGoogle(rt))
  registerRefreshFn('github-copilot', async (rt) => refreshGitHubCopilot(rt))

  ipcMain.handle(IPC.OAUTH_START, async (_event, { provider }: { provider: string }) => {
    log(`OAuth start: provider=${provider}`)
    activeFlows.get(provider)?.abort()
    const controller = new AbortController()
    activeFlows.set(provider, controller)
    try {
      let tokens: { accessToken: string; refreshToken: string; expiresAt: number }
      switch (provider) {
        case 'openai': tokens = await loginOpenAI(); break
        case 'google': tokens = await loginGoogle(); break
        case 'github-copilot': {
          const device = await startGitHubDeviceFlow()
          const ghToken = await pollGitHubAccessToken(device.deviceCode, device.interval, device.expiresIn, controller.signal)
          tokens = await exchangeGitHubForCopilotToken(ghToken)
          break
        }
        default: return { ok: false, error: `Unknown OAuth provider: ${provider}` }
      }
      await storeTokens(provider, tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
      return { ok: true }
    } catch (err) {
      log(`OAuth failed for ${provider}: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    } finally {
      activeFlows.delete(provider)
    }
  })

  ipcMain.handle(IPC.OAUTH_LOGOUT, async (_event, { provider }: { provider: string }) => {
    log(`OAuth logout: provider=${provider}`)
    await clearTokens(provider)
    return { ok: true }
  })

  ipcMain.handle(IPC.OAUTH_STATUS, async (_event, { provider }: { provider: string }) => {
    return { hasTokens: hasTokens(provider) }
  })

  ipcMain.handle(IPC.OAUTH_DEVICE_CODE, async (_event, { provider }: { provider: string }) => {
    if (provider !== 'github-copilot') return { ok: false, error: 'Device code flow only for github-copilot' }
    try {
      const d = await startGitHubDeviceFlow()
      return { ok: true, userCode: d.userCode, verificationUri: d.verificationUri, deviceCode: d.deviceCode, interval: d.interval, expiresIn: d.expiresIn }
    } catch (err) { return { ok: false, error: (err as Error).message } }
  })

  ipcMain.handle(IPC.OAUTH_DEVICE_POLL, async (_event, { deviceCode, interval, expiresIn }: { deviceCode: string; interval: number; expiresIn: number }) => {
    const controller = new AbortController()
    activeFlows.set('github-copilot-poll', controller)
    try {
      const ghToken = await pollGitHubAccessToken(deviceCode, interval, expiresIn, controller.signal)
      const tokens = await exchangeGitHubForCopilotToken(ghToken)
      await storeTokens('github-copilot', tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
      return { ok: true }
    } catch (err) { return { ok: false, error: (err as Error).message } }
    finally { activeFlows.delete('github-copilot-poll') }
  })
}
