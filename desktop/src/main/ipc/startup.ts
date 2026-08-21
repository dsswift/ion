import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { isStartupReport } from '../../shared/startup-state'
import {
  authenticateStartup,
  getStartupState,
  isSplashSender,
  quitStartup,
  reportStartup,
  restartStartup,
} from '../startup-coordinator'
import { warn } from '../logger'

export function registerStartupIpc(): void {
  ipcMain.handle(IPC.STARTUP_GET_STATE, () => getStartupState())
  ipcMain.on(IPC.STARTUP_REPORT, (event, report: unknown) => {
    if (!isStartupReport(report) || report.source === 'main') {
      warn('startup', 'startup report rejected: malformed or unauthorized payload')
      return
    }
    reportStartup(report, event.sender)
  })
  ipcMain.handle(IPC.STARTUP_AUTHENTICATE, async (event) => {
    if (!isSplashSender(event.sender)) return { ok: false, error: 'unauthorized startup sender' }
    try {
      await authenticateStartup()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.on(IPC.STARTUP_RELAUNCH, (event) => {
    if (!isSplashSender(event.sender)) return
    restartStartup()
  })
  ipcMain.on(IPC.STARTUP_QUIT, (event) => {
    if (!isSplashSender(event.sender)) return
    quitStartup()
  })
}
