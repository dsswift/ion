import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, screen, session, Tray } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/types'
import { log as _log, debug as _debug, info as _info, warn as _warn, error as _error, trace as _trace, flushLogs } from './logger'
import { enterprisePolicyCache, state, SPACES_DEBUG, sessionPlane, engineBridge } from './state'
import { broadcast } from './broadcast'
import { terminalManager } from './terminal-manager-instance'
import { openStudioWindow, reassertStudioActivationPolicy } from './studio-window-manager'
import { restartEngineDaemon } from './engine-bootstrap'
import { preserveWorktreeOverlapWindow } from './worktree-overlap-window'
import { resolveSurfacePlan } from './surface-launch'
import { readSettings } from './settings-store'
import { attemptRendererRecovery, resetRendererCrashGuard } from './renderer-crash-guard'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
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
 * when the launch surface is the Studio window: the renderer boots hidden and the
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
  // as a side effect. Harmless while no Studio window exists (accessory is the
  // overlay's resting policy), but with the Studio window open it silently removes
  // Ion from the Dock/Cmd-Tab — so every call re-asserts the correct policy.
  reassertStudioActivationPolicy()
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
    // A crashed renderer does NOT destroy the window: without recovery the
    // overlay becomes a transparent, click-blocking, permanently empty layer
    // over the whole desktop while the tray stays alive. Recover (bounded by
    // the crash-loop guard) instead of only logging.
    _error('main', '[renderer:gone]', { reason: details.reason, exit_code: details.exitCode })
    if (details.reason === 'clean-exit') return
    attemptRendererRecovery('overlay', details, () => {
      // The renderer-owned session store died with the process; the cached
      // projection of it is stale the moment the fresh renderer boots.
      state.rendererSnapshotCache = null
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.reload()
      } else {
        state.mainWindow = null
        createWindow(false)
      }
    })
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
          } catch (err) {
            debug('window_manager: tab flush skipped, window gone or renderer unresponsive', { error: String(err) })
          }
        }
        // Order matters, and only for Quit All: stop the sessions while the
        // socket is still live, THEN boot out the daemon. Reversed, every
        // stop_session is written to a dead socket.
        state.forceQuit = true
        terminalManager.destroyAll()
        // The dialog's own promise: Quit Desktop keeps engine sessions running.
        // Passing `shutdownEngine` here is what makes that text true — the
        // desktop drops its socket and the engine's ownership grace window
        // decides the rest, so relaunching reattaches to work still in flight.
        sessionPlane.shutdown({ stopSessions: shutdownEngine })
        if (shutdownEngine) {
          log('Quit All: shutting down engine process')
          await engineBridge.shutdownAndWait().catch((err: Error) => {
            log('window_manager: engine shutdown error, proceeding with quit', { error: err.message })
          })
        }
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
  // Single-UI exclusivity: only the ACTIVE conversation UI gets a tray
  // launcher — the inactive UI's item is ABSENT, never greyed. The tray is
  // rebuilt on every live activeUi switch (active-ui.ts).
  const plan = resolveSurfacePlan(readSettings(), enterprisePolicyCache.policy)
  state.tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(plan.overlayEnabled
        ? [{ label: 'Show Overlay', accelerator: 'Alt+Space', click: () => toggleWindow('tray menu') }]
        : []),
      ...(plan.studioEnabled
        ? [{ label: 'Show Ion Studio', accelerator: 'Alt+Space', click: () => openStudioWindow('tray menu') }]
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
        // Awaited off the click handler: restartEngineDaemon shells out to
        // launchctl, which is async so the main thread (and every renderer IPC
        // reply) stays live while it runs. void + catch because a menu click
        // handler cannot itself be async without floating the promise.
        void restartEngineDaemon()
          .then((ok) => { log('tray: restart engine requested', { issued: ok }) })
          .catch((err: unknown) => { error('tray: restart engine failed', { error: String(err) }) })
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit() } },
    ])
  )
}

export function ensureWindow(): void {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    createWindow()
  } else if (state.mainWindow.webContents.isCrashed?.()) {
    // The window survived a renderer crash (crashes don't destroy windows).
    // A manual show must never present the dead, transparent, click-blocking
    // shell — reload it, regardless of the automatic budget's state.
    log('ensureWindow: reloading crashed renderer on manual show')
    state.rendererSnapshotCache = null
    state.mainWindow.webContents.reload()
  }
  if (!state.tray || state.tray.isDestroyed()) {
    createTray()
  }
}

export function showWindow(source = 'unknown'): void {
  // The Overlay renderer stays alive as the session-store owner in Studio
  // mode, but its glass must never become visible there.
  const plan = resolveSurfacePlan(readSettings(), enterprisePolicyCache.policy)
  if (plan.activeUi !== 'overlay') {
    log('showWindow refused — overlay is not the active UI', { source, active_ui: plan.activeUi })
    return
  }
  // An operator explicitly summoning the overlay re-arms crash recovery,
  // even after the automatic budget was exhausted by a crash loop.
  resetRendererCrashGuard('overlay')
  ensureWindow()
  if (!state.mainWindow) return
  const toggleId = ++state.toggleSequence

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x: dx, y: dy, width: sw, height: sh } = display.workArea
  state.mainWindow.setBounds({ x: dx, y: dy, width: sw, height: sh })

  state.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Re-assert the activation policy: visibleOnFullScreen silently flips the
  // app to 'accessory', which (while the Studio window is open) removed Ion from
  // Cmd-Tab and sent the Studio window behind other apps on EVERY overlay show.
  reassertStudioActivationPolicy()

  if (SPACES_DEBUG) {
    log('[spaces] showWindow move to display', { toggle_id: toggleId, source, display_id: display.id })
    snapshotWindowState(`showWindow#${toggleId} pre-show`)
  }
  state.mainWindow.show()
  state.mainWindow.webContents.focus()
  preserveWorktreeOverlapWindow()
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
