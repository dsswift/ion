import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { terminalScrollback } from '../state'
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

  // Main-process scrollback for a terminal key.
  //
  // The renderer's xterm is a VIEWER over a main-owned PTY, and a PTY can be
  // created and stream output while its tab has never been mounted (a deep-link
  // pane opened into a background conversation, or an instance created from
  // iOS). In that window the only record of the output is `terminalScrollback`
  // in the main process — the renderer has no xterm to have received it.
  //
  // TerminalInstance.tsx calls this on first mount when it has no saved buffer
  // of its own, so arriving at such a tab shows the history that accumulated
  // before arrival instead of an empty pane.
  ipcMain.handle(IPC.TERMINAL_GET_SCROLLBACK, (_event, { key }: { key: string }) => {
    const buffer = terminalScrollback.get(key) || ''
    log('terminal_get_scrollback', { key, bytes: buffer.length })
    return buffer
  })
}
