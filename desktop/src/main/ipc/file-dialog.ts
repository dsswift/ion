import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '@ion/shared/types'
import { validateExternalUrl, isValidProjectPath } from '@ion/server/ipc-validation'
import { log as _log, warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('file-dialog', msg, fields)
}

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('file-dialog', msg, fields)
}

export function registerFileDialogIpc(): void {
  ipcMain.handle(IPC.SELECT_DIRECTORY, async (event) => {
    // Resolve the window that asked and parent the native dialog to it. The
    // Studio window is a normal window (unlike the deleted overlay glass, it
    // never needs hiding for a native dialog to render on top of it).
    const sender = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openDirectory' as const] }
    const result = process.platform === 'darwin' || !sender
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(sender, options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.SELECT_EXTENSION_FILES, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const extensionsDir = join(homedir(), '.ion', 'extensions')
    const options = {
      defaultPath: extensionsDir,
      properties: ['openFile' as const, 'multiSelections' as const],
      // Script entry points and native binaries are both loadable extension
      // entries: the engine transpiles .ts, runs .js/.mjs/.cjs via node, and
      // executes anything else directly (spawnAndInit in
      // engine/internal/extension/host_lifecycle.go). Electron's filter model
      // is extension-based and cannot express "executable bit set", so a
      // compiled binary like cos2's `main` (no file extension) matches only
      // the '*' filter — and macOS greys out everything the ACTIVE filter
      // rejects, defaulting to the first entry. The permissive filter must
      // therefore come first or native extensions are unselectable until the
      // user discovers the filter dropdown; the scripts filter remains as an
      // optional narrowing.
      filters: [
        { name: 'All Entry Points (scripts and native binaries)', extensions: ['*'] },
        { name: 'Script Entry Points', extensions: ['ts', 'js', 'mjs', 'cjs'] },
      ],
    }
    const result = process.platform === 'darwin' || !sender
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(sender, options)
    if (result.canceled) {
      log('extension file picker cancelled')
      return null
    }
    log('extension_file_picker: selected', { count: result.filePaths.length, paths: result.filePaths.join(', ') })
    return result.filePaths
  })

  // Reveal a path in the OS file manager. OPEN_EXTERNAL cannot serve this: it
  // validates for http(s) and rejects file:// by design. The path is checked
  // with the same absolute-path validator used elsewhere, and shell.openPath
  // only ever opens a location -- it never executes.
  ipcMain.handle(IPC.REVEAL_PATH, async (_event, path: string) => {
    if (!isValidProjectPath(path)) {
      warn('reveal_path: rejected invalid path', { path })
      return false
    }
    try {
      shell.showItemInFolder(path)
      log('reveal_path', { path })
      return true
    } catch (err) {
      warn('reveal_path failed', { path, error: String(err) })
      return false
    }
  })

  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    const validUrl = validateExternalUrl(url)
    if (!validUrl) return false
    try {
      await shell.openExternal(validUrl)
      return true
    } catch {
      return false
    }
  })
}
