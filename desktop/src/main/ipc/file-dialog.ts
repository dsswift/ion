import { dialog, ipcMain, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { state } from '../state'
import { showWindow } from '../window-manager'
import { validateExternalUrl } from '../ipc-validation'
import { engineIsRemote, getEngineHostInfo, listEngineDirectory } from '../engine-bridge-fs'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('file-dialog', msg)
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
      filters: [
        { name: 'Extension Entry Points', extensions: ['ts', 'js', 'mjs', 'cjs'] },
        { name: 'All Files', extensions: ['*'] },
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
    log(`extension file picker: user selected ${result.filePaths.length} file(s): ${result.filePaths.join(', ')}`)
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
