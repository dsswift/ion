import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { IPC } from '@ion/shared/types'
import { isValidProjectPath, sanitizeDialogFilters } from '@ion/server/ipc-validation'
import { log, warn } from '../logger'
import { safeCopyName, writeOpenCopy } from './open-native-data'

/**
 * Filesystem IPC — a thin adapter over `@ion/server/files/file-api` for
 * everything portable, plus the three verbs that genuinely need Electron.
 *
 * The portable bodies (read/write/create/rename/delete/exists/watch) moved
 * to the server package so both callers share one copy: a browser Studio
 * client reaches the same functions as `fs.*` studio_actions
 * (`protocol/file-actions.ts`). Before that move they were Electron-only by
 * accident, and the Explorer rendered as a root node with no children in a
 * browser for want of a transport.
 *
 * The save dialog, Reveal in Finder, and Open With stay here and stay
 * Electron-only: they are OS shell integrations with no server-side
 * meaning, and a browser client refuses them correctly. Open With and Save
 * also have by-content forms for a file that lives on a remote Environment.
 */
export function registerFilesIpc(): void {
  // read/write/create/rename/delete/exists/watch are `fs.*` studio_actions
  // on every host (server/src/protocol/file-actions.ts); nothing here.
  ipcMain.handle(IPC.FS_SAVE_DIALOG, async (event, payload: unknown) => {
    const args = payload != null && typeof payload === 'object'
      ? payload as { defaultPath?: unknown; defaultFileName?: unknown; filters?: unknown }
      : {}
    const { defaultPath, defaultFileName } = args
    const filters = sanitizeDialogFilters(args.filters)
    if (args.filters != null && !filters) {
      warn('files', 'save dialog rejected invalid filters')
      return { filePath: null, error: 'Invalid filters' }
    }
    const sender = BrowserWindow.fromWebContents(event.sender)

    if (defaultPath != null && (typeof defaultPath !== 'string' || !isValidProjectPath(defaultPath))) {
      warn('files', 'save dialog rejected invalid default path')
      return { filePath: null, error: 'Invalid default path' }
    }
    let resolvedDefaultPath = defaultPath || undefined
    if (defaultFileName != null) {
      if (typeof defaultFileName !== 'string' || defaultFileName.length === 0 || /[/\\\0\r\n]/.test(defaultFileName)) {
        warn('files', 'save dialog rejected invalid default filename', { default_file_name: defaultFileName })
        return { filePath: null, error: 'Invalid default filename' }
      }
      resolvedDefaultPath = join(app.getPath('downloads'), defaultFileName)
    }

    log('files', 'opening save dialog', {
      sender_window: sender ? 'application' : 'unowned',
      default_path: resolvedDefaultPath ?? '',
    })
    try {
      const options = { defaultPath: resolvedDefaultPath, ...(filters ? { filters } : {}) }
      const result = sender
        ? await dialog.showSaveDialog(sender, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) {
        log('files', 'save dialog cancelled')
        return { filePath: null }
      }
      log('files', 'save dialog selected path', { path: result.filePath })
      return { filePath: result.filePath }
    } catch (error) {
      warn('files', 'save dialog failed', { error: String(error) })
      return { filePath: null, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FS_REVEAL_IN_FINDER, async (_event, { targetPath }: { targetPath: string }) => {
    if (!isValidProjectPath(targetPath)) return
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle(IPC.FS_OPEN_NATIVE, async (_event, { targetPath }: { targetPath: string }) => {
    if (!isValidProjectPath(targetPath)) return { ok: false, error: 'Invalid path' }
    try {
      const err = await shell.openPath(targetPath)
      if (err) return { ok: false, error: err }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // A remote Environment's file, sent as bytes: write a local copy, open that.
  ipcMain.handle(IPC.FS_OPEN_NATIVE_DATA, async (_event, payload: unknown) => {
    const { name, base64 } = (payload ?? {}) as { name?: unknown; base64?: unknown }
    if (typeof name !== 'string' || typeof base64 !== 'string') {
      warn('files', 'open native copy refused: malformed payload')
      return { ok: false, error: 'Invalid payload' }
    }
    try {
      const copy = writeOpenCopy(join(app.getPath('temp'), 'ion-opened-attachments'), name, Buffer.from(base64, 'base64'))
      const err = await shell.openPath(copy)
      if (err) {
        warn('files', 'open native copy failed', { path: copy, error: err })
        return { ok: false, error: err }
      }
      log('files', 'opened native copy', { path: copy })
      return { ok: true }
    } catch (err) {
      warn('files', 'open native copy threw', { error: String(err) })
      return { ok: false, error: (err as Error).message }
    }
  })

  // A remote Environment's file, sent as bytes: ask where to keep it, starting
  // in Downloads, and write it there.
  ipcMain.handle(IPC.FS_SAVE_DATA, async (event, payload: unknown) => {
    const { name, base64 } = (payload ?? {}) as { name?: unknown; base64?: unknown }
    if (typeof name !== 'string' || typeof base64 !== 'string') {
      warn('files', 'save copy refused: malformed payload')
      return { filePath: null, error: 'Invalid payload' }
    }
    const defaultPath = join(app.getPath('downloads'), safeCopyName(name))
    const sender = BrowserWindow.fromWebContents(event.sender)
    try {
      const result = sender
        ? await dialog.showSaveDialog(sender, { defaultPath })
        : await dialog.showSaveDialog({ defaultPath })
      if (result.canceled || !result.filePath) {
        log('files', 'save copy cancelled', { default_path: defaultPath })
        return { filePath: null }
      }
      await writeFile(result.filePath, Buffer.from(base64, 'base64'))
      log('files', 'saved copy', { path: result.filePath })
      return { filePath: result.filePath }
    } catch (err) {
      warn('files', 'save copy failed', { default_path: defaultPath, error: String(err) })
      return { filePath: null, error: (err as Error).message }
    }
  })
}
