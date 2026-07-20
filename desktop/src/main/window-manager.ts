import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, screen, session, Tray } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/types'
import { log as _log, debug as _debug, info as _info, warn as _warn, error as _error, trace as _trace, flushLogs } from './logger'
import { state, SPACES_DEBUG, sessionPlane, engineBridge } from './state'
import { broadcast } from './broadcast'
import { terminalManager } from './terminal-manager-instance'
import { openAtvWindow, reassertAtvActivationPolicy } from './atv-window-manager'
import { restartEngineDaemon } from './engine-bootstrap'
import { resolveSurfacePlan } from './surface-launch'
import { readSettings } from './settings-store'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

export function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    log('[spaces] no window', { reason })
    return
  }

  const win = state.mainWindow
  const b = win.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = win.isVisibleOnAllWorkspaces()
  const wcFocused = win.webContents.isFocused()

  log(
    `[spaces] ${reason} ` +
    `vis=${win.isVisible()} focused=${win.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${win.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

export function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}

function getContentSecurityPolicy(): string {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  if (isDev) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://localhost:*",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
}

export function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [getContentSecurityPolicy()],
      },
    })
  })
}

/**
 * Create the overlay window (the session-store OWNER renderer — it always
 * exists, even when its glass surface never shows). `showOnReady` is false
 * when the launch surface is the ATV: the renderer boots hidden and the
 * glass appears only when summoned (Alt+Space / tray).
 */
export function createWindow(showOnReady = true): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: dx, y: dy, width: sw, height: sh } = display.workArea

  const mainWindow = new BrowserWindow({
    width: sw,
    height: sh,
    x: dx,
    y: dy,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  state.mainWindow = mainWindow

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // visibleOnFullScreen flips the app to the 'accessory' activation policy
  // as a side effect. Harmless while no ATV window exists (accessory is the
  // overlay's resting policy), but with the ATV open it silently removes
  // Ion from the Dock/Cmd-Tab — so every call re-asserts the correct policy.
  reassertAtvActivationPolicy()
  // Use 'modal-panel' rather than 'screen-saver' here. 'modal-panel' sits
  // above normal apps (browsers, VSCode — CGWindowLevel 0) so the overlay
  // covers them in tall mode, but it stays BELOW macOS TCC/permission dialogs
  // and the Dock (which live at kCGPopUpMenuWindowLevel and above). That lets
  // system permission prompts surface over the Ion overlay when they fire.
  //
  // DO NOT raise this back to 'screen-saver' to fix a perceived z-order bug.
  // 'screen-saver' is CGWindowLevel 2000, which sits above TCC dialogs
  // (~1000) and causes them to be hidden behind the overlay in tall mode —
  // the exact symptom this change was made to cure.
  mainWindow.setAlwaysOnTop(true, 'modal-panel')

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    // Electron console-message levels: 0=verbose, 1=info/log, 2=warning, 3=error
    // Post-migration mapping (safety net for renderer console.* calls that bypass
    // the rendererLogger bridge):
    //   level 0 (verbose/console.debug) → DEBUG
    //   level 1 (info/console.log)      → TRACE  (high-frequency; below default INFO gate)
    //   level 2 (warning/console.warn)  → WARN
    //   level 3 (error/console.error)   → ERROR
    if (level >= 3) {
      _error('renderer', message)
    } else if (level === 2) {
      _warn('renderer', message)
    } else if (level === 0) {
      _debug('renderer', message)
    } else {
      // level 1 — console.log / console.info: route to TRACE so they are
      // suppressed at the default INFO min-level and only visible when the
      // operator lowers the desktop log level to TRACE.
      _trace('renderer', message)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('[renderer:gone]', { reason: details.reason, exit_code: details.exitCode })
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.once('ready-to-show', () => {
    // The click-through arm applies even when the glass stays hidden: a
    // later showWindow() must find the overlay already in its safe
    // pass-through state.
    if (showOnReady) state.mainWindow?.show()
    state.mainWindow?.setIgnoreMouseEvents(true, { forward: true })
    if (process.env.ELECTRON_RENDERER_URL) {
      state.mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  app.on('before-quit', (e) => {
    if (state.forceQuit) return
    e.preventDefault()
    const hasRunning = sessionPlane.hasRunningTabs()
    // 0 = Quit Desktop (engine keeps running)
    // 1 = Quit All (engine shuts down too)
    // 2 = Cancel
    const choice = dialog.showMessageBoxSync(state.mainWindow!, {
      type: 'question',
      buttons: ['Quit Desktop', 'Quit All', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
      title: 'Quit Ion?',
      message: hasRunning
        ? 'Sessions are running in the engine.'
        : 'How would you like to quit?',
      detail: hasRunning
        ? 'Quit Desktop closes the window but keeps engine sessions running.\nQuit All stops the engine and all running sessions.\n\nTip: ⌥Space hides/shows the window without quitting.'
        : 'Quit Desktop closes the window but keeps the engine running.\nQuit All stops the engine too.\n\nTip: ⌥Space hides/shows the window without quitting.',
    })
    if (choice === 0 || choice === 1) {
      const shutdownEngine = choice === 1
      // Flush renderer tab state before exiting — the Zustand store debounces
      // persistTabs() at 100ms and app.exit(0) kills the renderer immediately,
      // so any pending state (conversationId, titles, etc.) would be lost.
      void (async () => {
        for (const win of BrowserWindow.getAllWindows()) {
          try {
            await win.webContents.executeJavaScript(
              'window.__ionForceFlushTabs && window.__ionForceFlushTabs()',
            )
          } catch {
            // Window may already be destroyed or renderer unresponsive.
          }
        }
        if (shutdownEngine) {
          log('Quit All: shutting down engine process')
          await engineBridge.shutdownAndWait().catch((err: Error) => {
            log('window_manager: engine shutdown error, proceeding with quit', { error: err.message })
          })
        }
        state.forceQuit = true
        terminalManager.destroyAll()
        sessionPlane.shutdown()
        globalShortcut.unregisterAll()
        if (state.tray) {
          state.tray.destroy()
          state.tray = null
        }
        flushLogs()
        app.exit(0)
      })()
    }
  })
  mainWindow.on('close', (e) => {
    if (!state.forceQuit) {
      e.preventDefault()
      state.mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    state.mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch((err) => error('window_manager: overlay loadURL failed', { error: String(err) }))
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((err) => error('window_manager: overlay loadFile failed', { error: String(err) }))
  }
}

export function createTray(): void {
  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  state.tray = new Tray(trayIcon)
  state.tray.setToolTip('Ion')
  // Both surfaces get a tray launcher — the tray is the one entry point that
  // works in every window state. Disabled surfaces (surfacePolicy) lose
  // their item entirely.
  const plan = resolveSurfacePlan(readSettings())
  state.tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(plan.overlayEnabled
        ? [{ label: 'Show Overlay', accelerator: 'Alt+Space', click: () => toggleWindow('tray menu') }]
        : []),
      ...(plan.atvEnabled
        ? [{ label: 'Show Visualizer', ...(plan.atvShortcut ? { accelerator: plan.atvShortcut } : {}), click: () => openAtvWindow('tray menu') }]
        : []),
      { type: 'separator' },
      { label: 'Settings...', click: () => {
        showWindow('tray settings')
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send(IPC.SHOW_SETTINGS)
        }
      } },
      { type: 'separator' },
      // Force-restart the persistent engine daemon so it re-reads engine.json.
      // The engine reads its config once at process start; a config change needs
      // an explicit restart. This recycles the daemon in place (kickstart -k)
      // without quitting the desktop or booting the daemon out — launchd
      // respawns it immediately with fresh config. Distinct from Quit All (which
      // boots the daemon out) and Quit Desktop (which leaves it running).
      { label: 'Restart Engine', click: () => {
        const ok = restartEngineDaemon()
        log('tray: restart engine requested', { issued: ok })
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit() } },
    ])
  )
}

export function ensureWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    createWindow()
  }
  if (!state.tray || state.tray.isDestroyed()) {
    createTray()
  }
}

export function showWindow(source = 'unknown'): void {
  ensureWindow()
  if (!state.mainWindow) return
  const toggleId = ++state.toggleSequence

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: dx, y: dy, width: sw, height: sh } = display.workArea
  state.mainWindow.setBounds({ x: dx, y: dy, width: sw, height: sh })

  state.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Re-assert the activation policy: visibleOnFullScreen silently flips the
  // app to 'accessory', which (while the ATV is open) removed Ion from
  // Cmd-Tab and sent the ATV window behind other apps on EVERY overlay show.
  reassertAtvActivationPolicy()

  if (SPACES_DEBUG) {
    log('[spaces] showWindow move to display', { toggle_id: toggleId, source, display_id: display.id })
    snapshotWindowState(`showWindow#${toggleId} pre-show`)
  }
  state.mainWindow.show()
  state.mainWindow.webContents.focus()
  broadcast(IPC.WINDOW_SHOWN)
  if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'show')
}

export function toggleWindow(source = 'unknown'): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return
  const toggleId = ++state.toggleSequence
  if (SPACES_DEBUG) {
    log('[spaces] toggle start', { toggle_id: toggleId, source })
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  if (state.mainWindow.isVisible()) {
    state.mainWindow.hide()
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    showWindow(source)
  }
}
