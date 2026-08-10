import { dialog, ipcMain, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { state } from '../state'
import { showWindow } from '../window-manager'
import { validateExternalUrl, isValidProjectPath } from '../ipc-validation'
import { engineIsRemote, getEngineHostInfo, listEngineDirectory, getEnterprisePolicyNewConversationDefaults, getEnterprisePolicy } from '../engine-bridge-fs'
import { log as _log, warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('file-dialog', msg, fields)
}

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('file-dialog', msg, fields)
}

export function registerFileDialogIpc(): void {
  ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
    if (!state.mainWindow) return null
    state.mainWindow.hide()
    const options = { properties: ['openDirectory' as const] }
    const result = process.platform === 'darwin'
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(state.mainWindow, options)
    showWindow('dialog-return')
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.SELECT_EXTENSION_FILES, async () => {
    if (!state.mainWindow) return null
    state.mainWindow.hide()
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
    const result = process.platform === 'darwin'
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(state.mainWindow!, options)
    state.mainWindow?.show()
    if (result.canceled) {
      log('extension file picker cancelled')
      return null
    }
    log('extension_file_picker: selected', { count: result.filePaths.length, paths: result.filePaths.join(', ') })
    return result.filePaths
  })

  // Engine-host filesystem RPCs. Used by the remote-aware directory picker
  // so the user browses the engine's filesystem (which is the cwd the engine
  // chdir's into when spawning the Claude CLI) rather than the desktop's
  // local filesystem. Local-engine setups also use these for symmetry.

  ipcMain.handle(IPC.GET_ENGINE_HOST_INFO, async () => getEngineHostInfo())

  ipcMain.handle(
    IPC.LIST_ENGINE_DIRECTORY,
    async (_event, path: string, showHidden: boolean) => listEngineDirectory(path ?? '', !!showHidden),
  )

  ipcMain.handle(IPC.ENGINE_IS_REMOTE, async () => engineIsRemote())

  // Enterprise policy: fetch the NewConversationDefaults section from the engine's
  // merged config (includes MDM/system-level settings). Returns null when no
  // enterprise config is active.
  ipcMain.handle(IPC.GET_ENTERPRISE_POLICY, async () => getEnterprisePolicyNewConversationDefaults())

  // Full enterprise policy blob (D-004): the complete EnterpriseConfig
  // passthrough, consumed by the renderer for model-picker filtering (D-011)
  // and any other client-side enterprise constraint. Null when no
  // enterprise config is active.
  ipcMain.handle(IPC.GET_ENTERPRISE_POLICY_FULL, async () => getEnterprisePolicy())

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
