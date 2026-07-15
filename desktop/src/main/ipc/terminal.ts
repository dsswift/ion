import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { terminalManager } from '../terminal-manager-instance'

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

  ipcMain.handle(IPC.TERMINAL_DESTROY, (_event, { key }: { key: string }) => {
    log('terminal_destroy', { key })
    terminalManager.destroy(key)
  })
}
