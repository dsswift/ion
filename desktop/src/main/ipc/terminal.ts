import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { terminalManager } from '../terminal-manager-instance'
import { restoredStudioExitCodes } from '../studio-terminal-persistence'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export function registerTerminalIpc(): void {
  ipcMain.handle(IPC.TERMINAL_CREATE, (_event, { key, cwd }: { key: string; cwd: string }) => {
    log('terminal_create', { key, cwd })
    terminalManager.create(key, cwd)
  })

  ipcMain.on(IPC.TERMINAL_DATA, (_event, { key, data }: { key: string; data: string }) => {
    terminalManager.write(key, data)
  })

  ipcMain.on(IPC.TERMINAL_RESIZE, (_event, { key, cols, rows }: { key: string; cols: number; rows: number }) => {
    terminalManager.resize(key, cols, rows)
  })

  ipcMain.handle(IPC.TERMINAL_ACTIVE_TABS, () => terminalManager.activeTabIds())
  ipcMain.handle(IPC.TERMINAL_ACTIVITY_SNAPSHOT, () => terminalManager.activitySnapshot())

  ipcMain.handle(IPC.TERMINAL_DESTROY, (_event, { key }: { key: string }) => {
    log('terminal_destroy', { key })
    terminalManager.destroy(key)
  })

  // Attach protocol (D2): one call returns {history, running, exitCode,
  // cwd, cwdFellBack}; the caller then rides the live TERMINAL_INCOMING
  // stream. restartIfNotRunning respawns a dead terminal on demand (dead
  // cwd falls back to ~, reported via cwdFellBack for a visible notice).
  ipcMain.handle(
    IPC.TERMINAL_ATTACH,
    (_event, { key, restartIfNotRunning, cwd }: { key: string; restartIfNotRunning?: boolean; cwd?: string }) => {
      const info = terminalManager.attach(key, { restartIfNotRunning, cwd })
      // A terminal restored from disk (app restart) has history but no
      // manager lifecycle until it respawns; report its persisted exit code
      // so the client renders the exited state instead of "running".
      if (!info.running && info.exitCode === null && restoredStudioExitCodes.has(key)) {
        info.exitCode = restoredStudioExitCodes.get(key) ?? null
      }
      log('terminal_attach', { key, running: info.running, exit_code: info.exitCode ?? '', history_bytes: info.history.length, restart: !!restartIfNotRunning, cwd_fell_back: info.cwdFellBack })
      return info
    },
  )
}
