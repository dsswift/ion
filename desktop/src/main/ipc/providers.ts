import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { engineBridge } from '../state'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('providers-ipc', msg, fields)
}

export function registerProvidersIpc(): void {
  ipcMain.handle(IPC.PROVIDER_LOGIN, async (_e, { provider }: { provider: string }) => {
    log('provider_login', { provider })
    return engineBridge.providerLogin(provider)
  })

  ipcMain.handle(IPC.PROVIDER_LOGIN_CANCEL, async (_e, { provider }: { provider: string }) => {
    log('provider_login_cancel', { provider })
    return engineBridge.providerLoginCancel(provider)
  })

  // Returns a browser-issued authorization code to a login parked on the
  // await_auth_code stage (claude-code). The code is a bearer-grade secret, so
  // only its length is logged, never its value.
  ipcMain.handle(IPC.PROVIDER_LOGIN_CODE, async (_e, { provider, code }: { provider: string; code: string }) => {
    if (typeof provider !== 'string' || !provider || typeof code !== 'string' || !code.trim()) {
      log('provider_login_code rejected: malformed input', { provider, hasCode: typeof code === 'string' && code.trim().length > 0 })
      return { ok: false, error: 'provider and code are required' }
    }
    log('provider_login_code', { provider, codeLength: code.trim().length })
    return engineBridge.providerLoginCode(provider, code.trim())
  })

  ipcMain.handle(IPC.PROVIDER_LOGOUT, async (_e, { provider }: { provider: string }) => {
    log('provider_logout', { provider })
    return engineBridge.providerLogout(provider)
  })

}
