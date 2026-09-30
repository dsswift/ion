import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { state } from './state'
import { error, log } from './logger'

const SPLASH_WIDTH = 720
const SPLASH_HEIGHT = 440

export function createStartupWindow(): BrowserWindow {
  const existing = state.splashWindow
  if (existing && !existing.isDestroyed()) return existing

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    x: Math.round(x + (width - SPLASH_WIDTH) / 2),
    y: Math.round(y + (height - SPLASH_HEIGHT) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    // An ordinary window, not a floating one: it opens in front, but clicking
    // another app sends it behind that app, and it takes part in Cmd-Tab,
    // Stage Manager and the Windows taskbar like any other window. Pinned on
    // top it covered the installer and the browser sign-in page it had just
    // opened, so the user had to drag the browser aside to reach it.
    movable: true,
    minimizable: true,
    title: 'Ion',
    hasShadow: true,
    roundedCorners: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  state.splashWindow = win

  win.once('ready-to-show', () => {
    if (state.splashWindow !== win || win.isDestroyed()) return
    // Launched from the installer or the Dock, the splash opens in front once.
    // After this it is an ordinary window the user may leave behind.
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.show()
    log('startup', 'startup splash shown')
  })
  win.on('closed', () => {
    if (state.splashWindow === win) state.splashWindow = null
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    error('startup', 'startup splash renderer exited', {
      reason: details.reason,
      exit_code: details.exitCode,
    })
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/splash.html`).catch((err) =>
      error('startup', 'startup splash loadURL failed', { error: String(err) }),
    )
  } else {
    void win.loadFile(join(__dirname, '../renderer/splash.html')).catch((err) =>
      error('startup', 'startup splash loadFile failed', { error: String(err) }),
    )
  }
  log('startup', 'startup splash window created', { width: SPLASH_WIDTH, height: SPLASH_HEIGHT })
  return win
}
