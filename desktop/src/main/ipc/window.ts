import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { IPC } from '../../shared/types'
import { state } from '../state'
import { broadcast } from '../broadcast'

export function registerWindowIpc(): void {
  ipcMain.on(IPC.RESIZE_HEIGHT, () => {
    // No-op — fixed height window, no dynamic resize
  })

  ipcMain.on(IPC.SET_WINDOW_WIDTH, () => {
    // No-op — native width is fixed to keep expand/collapse animation smooth.
  })

  ipcMain.handle(IPC.ANIMATE_HEIGHT, () => {
    // No-op — kept for API compat, animation handled purely in renderer
  })

  ipcMain.on(IPC.HIDE_WINDOW, () => {
    state.mainWindow?.hide()
  })

  ipcMain.handle(IPC.IS_VISIBLE, () => {
    return state.mainWindow?.isVisible() ?? false
  })

  ipcMain.on(IPC.SET_IGNORE_MOUSE_EVENTS, (event, ignore: boolean, options?: { forward?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, options || {})
    }
  })

  ipcMain.handle(IPC.START, async () => {
    return { version: app.getVersion(), auth: {}, mcpServers: [], projectPath: process.cwd(), homePath: require('os').homedir() }
  })

  ipcMain.handle(IPC.GET_THEME, () => {
    return { isDark: nativeTheme.shouldUseDarkColors }
  })

  nativeTheme.on('updated', () => {
    broadcast(IPC.THEME_CHANGED, nativeTheme.shouldUseDarkColors)
  })
}
