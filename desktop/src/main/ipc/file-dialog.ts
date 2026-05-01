import { dialog, ipcMain, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { state } from '../state'
import { showWindow } from '../window-manager'
import { validateExternalUrl } from '../ipc-validation'

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
    const ionHome = join(homedir(), '.ion')
    const options = {
      defaultPath: ionHome,
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Extensions', extensions: ['ts', 'js'] }],
    }
    const result = process.platform === 'darwin'
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(state.mainWindow!, options)
    state.mainWindow?.show()
    return result.canceled ? null : result.filePaths
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
