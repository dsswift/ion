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

  ipcMain.handle(IPC.PROVIDER_LOGOUT, async (_e, { provider }: { provider: string }) => {
    log('provider_logout', { provider })
    return engineBridge.providerLogout(provider)
  })

}
