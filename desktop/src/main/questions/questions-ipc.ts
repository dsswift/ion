/**
 * Electron-bound Questions IPC — the renderer-facing half of Questions
 * wiring. The headless coordinator, fan-out, and engine-event intake live in
 * `@ion/server/questions/questions-wiring` (moved there by the Ion Studio
 * Server program's child 06); this file registers the `ipcMain.handle` calls
 * the one handler that genuinely requires a native dialog parented to a
 * `BrowserWindow` (the attachment picker). Called once at startup
 * (ipc/register.ts); the coordinator itself is wired by the Studio server.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename } from 'path'
import { IPC } from '@ion/shared/types'
import { log as _log } from '../logger'

const TAG = 'questions-ipc'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

export function registerQuestionsIpc(): void {
  // Reads, patches, actions and rehydration are `questions.*` studio_actions
  // served by the Studio server (protocol/misc-actions.ts); nothing here.
  ipcMain.handle(IPC.QUESTIONS_PICK_ATTACHMENTS, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const options = {
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'] }],
    }
    const result = process.platform === 'darwin' || !sender
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(sender, options)
    if (result.canceled) return []
    log('questions attachment picker selected', { count: result.filePaths.length })
    return result.filePaths.map((p) => ({ path: p, name: basename(p) }))
  })

  log('questions IPC registered')
}
