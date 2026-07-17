/**
 * atv-window-manager — lifecycle for the Agent Team Visualizer window.
 *
 * A single standard (framed, resizable) BrowserWindow, separate from the
 * frameless main overlay. Never more than one: opening focuses the existing
 * window. The window loads the second renderer entry (atv.html) with the same
 * preload surface as the main renderer, so it consumes the same
 * `ion:normalized-event` stream (filtered in broadcast.ts).
 *
 * The ATV is a standalone window, fully decoupled from the overlay's
 * show/hide lifecycle: open means open until the user closes it, regardless
 * of what Alt+Space does to the overlay.
 *
 * Pin semantics:
 *   - pinned: visible on all workspaces, alwaysOnTop at the 'floating' level
 *     (deliberately BELOW the main overlay's 'modal-panel' — see the TCC
 *     warning in window-manager.ts), floating over other NORMAL windows.
 *   - unpinned: a plain normal window (one Space, normal stacking).
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/types'
import { log as _log, debug as _debug, warn as _warn, error as _error, trace as _trace } from './logger'
import { state } from './state'
import { readSettings, writeSettings } from './settings-store'
import { getAtvState } from './atv-state-cache'
import { clearBeacon } from './atv-beacon'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('atv', msg, fields)
}

const ATV_DEFAULT_WIDTH = 960
const ATV_DEFAULT_HEIGHT = 640

/** Persisted window bounds ({} when never saved). One global state. */
function savedAtvBounds(): Partial<Electron.Rectangle> {
  try {
    const b = readSettings().atvBounds
    if (b && typeof b === 'object' && Number.isFinite(b.width) && Number.isFinite(b.height)) {
      return b as Partial<Electron.Rectangle>
    }
  } catch {
    // Unreadable settings: defaults below.
  }
  return {}
}

let boundsTimer: ReturnType<typeof setTimeout> | null = null
function persistAtvBounds(win: BrowserWindow): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    if (win.isDestroyed()) return
    try {
      const settings = readSettings()
      settings.atvBounds = win.getBounds()
      writeSettings(settings)
    } catch (err) {
      _error('atv', 'atv_window: bounds persist failed', { error: String(err) })
    }
  }, 400)
}

/**
 * Persist whether the ATV window is open (one global flag, like atvBounds).
 * surface-launch reads it at startup so an ATV left open at quit reopens —
 * unless the surface policy disabled the ATV between restarts.
 */
function persistAtvOpenState(open: boolean): void {
  try {
    const settings = readSettings()
    settings.atvWindowOpen = open
    writeSettings(settings)
    log('atv_window: open state persisted', { open })
  } catch (err) {
    _error('atv', 'atv_window: open state persist failed', { error: String(err) })
  }
}

/** Read the persisted pin state (defaults false). */
export function isAtvPinned(): boolean {
  try {
    return readSettings().atvPinned === true
  } catch {
    return false
  }
}

/**
 * Apply pin behavior to the ATV window and persist the choice.
 * Safe to call with no window (persists only).
 */
export function applyAtvPin(pinned: boolean): void {
  try {
    const settings = readSettings()
    settings.atvPinned = pinned
    writeSettings(settings)
  } catch (err) {
    _error('atv', 'atv_pin: settings write failed', { error: String(err) })
  }
  const win = state.atvWindow
  if (!win || win.isDestroyed()) {
    log('atv_pin: persisted without window', { pinned })
    return
  }
  if (pinned) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // 'floating' (not 'modal-panel'/'screen-saver'): stays above normal app
    // windows but below the Ion overlay and macOS TCC dialogs. Focus raises
    // it to the overlay's level (see the focus/blur wiring in openAtvWindow).
    win.setAlwaysOnTop(true, 'floating')
    // setVisibleOnAllWorkspaces with visibleOnFullScreen flips the app's
    // activation policy to accessory as a macOS/Electron side effect —
    // silently undoing the ATV's Dock/Cmd-Tab presence. Re-assert it.
    reassertAtvActivationPolicy()
  } else {
    win.setVisibleOnAllWorkspaces(false)
    win.setAlwaysOnTop(false)
  }
  log('atv_pin: applied', { pinned })
}

/**
 * Focus raises the ATV to the main overlay's own window level so it is never
 * stuck behind the conversation overlay while the user is interacting with
 * it; blur restores the pin-appropriate resting level. Same 'modal-panel'
 * ceiling as the overlay — never higher (see the TCC warning in
 * window-manager.ts).
 */
function applyAtvFocusLevel(win: BrowserWindow, focused: boolean): void {
  if (win.isDestroyed()) return
  if (focused) {
    win.setAlwaysOnTop(true, 'modal-panel')
    win.moveTop()
  } else if (isAtvPinned()) {
    win.setAlwaysOnTop(true, 'floating')
  } else {
    win.setAlwaysOnTop(false)
  }
  rearmOverlayClickThrough('atv focus change')
  log('atv_window: focus level', { focused, pinned: isAtvPinned() })
}

/**
 * Re-arm the main overlay's mouse-event forwarding.
 *
 * The full-screen transparent overlay relies on setIgnoreMouseEvents(true,
 * {forward: true}): forwarded mousemoves drive the renderer's click-through
 * hook, which un-ignores over interactive UI. Creating or focusing a SECOND
 * window invalidates the macOS mouse-tracking area behind that forwarding —
 * the renderer stops receiving mousemoves, its ignore state goes stale, and
 * every click either passes through the overlay to background apps or gets
 * eaten by the invisible shell (the reported symptom; hiding and re-showing
 * the overlay "fixed" it because show recreates the tracking area). Forcing
 * ignore+forward from the main process on every ATV lifecycle transition
 * recreates the tracking area and resets the overlay to its safe state
 * (pass-through until the renderer sees the cursor over real UI again).
 */
function rearmOverlayClickThrough(reason: string): void {
  const main = state.mainWindow
  if (!main || main.isDestroyed()) return
  main.setIgnoreMouseEvents(true, { forward: true })
  log('atv_window: overlay click-through re-armed', { reason })
}

/**
 * Dock/Cmd-Tab presence: Ion runs as a macOS accessory app (no Dock icon) so
 * the overlay stays a hotkey surface. The ATV is a normal window the user
 * switches to like an app, so while it is open — and the atvDockPresence
 * setting allows it — the activation policy flips to 'regular' (Dock icon,
 * Cmd-Tab entry). Closing the ATV reverts to accessory. No-op off macOS.
 */
export function applyAtvActivationPolicy(atvOpen: boolean): void {
  if (process.platform !== 'darwin') return
  let allowed = true
  try {
    allowed = readSettings().atvDockPresence !== false
  } catch {
    // Unreadable settings: keep the default (present).
  }
  const regular = atvOpen && allowed
  try {
    app.setActivationPolicy(regular ? 'regular' : 'accessory')
    if (!regular && app.dock) app.dock.hide()
    log('atv_window: activation policy', { policy: regular ? 'regular' : 'accessory', atv_open: atvOpen, allowed })
  } catch (err) {
    _error('atv', 'atv_window: activation policy failed', { error: String(err) })
  }
}

/** True when a live ATV window exists (used by the app 'activate' router). */
export function isAtvWindowOpen(): boolean {
  return state.atvWindow != null && !state.atvWindow.isDestroyed()
}

/**
 * Re-assert the activation policy for the CURRENT ATV open state.
 *
 * Electron's setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})
 * flips the app to the 'accessory' activation policy as a side effect
 * (over-fullscreen visibility requires a UIElement app on macOS). The
 * overlay runs that call on EVERY show, and the ATV pin path runs it too —
 * each silently knocking Ion out of the Dock and Cmd-Tab while the ATV is
 * open, sending the ATV window behind the previous app. Every call site of
 * setVisibleOnAllWorkspaces(..., {visibleOnFullScreen: true}) must call
 * this afterwards. Known trade-off: while the ATV holds 'regular' policy,
 * the overlay cannot float over OTHER apps' fullscreen Spaces (macOS allows
 * one or the other, not both).
 */
export function reassertAtvActivationPolicy(): void {
  applyAtvActivationPolicy(isAtvWindowOpen())
}

/** Push ATV open/closed to the overlay renderer (launcher-button indicator). */
function notifyAtvWindowState(open: boolean): void {
  const main = state.mainWindow
  if (!main || main.isDestroyed()) return
  main.webContents.send(IPC.ATV_WINDOW_STATE, open)
}

/**
 * Push "this permission was answered (by any surface)" to the ATV window so
 * its mirror queue and canvas bubble clear instantly. Fired from the
 * respondToPermission choke point in the control plane.
 */
export function notifyAtvPermissionResolved(tabId: string, questionId: string): void {
  const win = state.atvWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.ATV_PERMISSION_RESOLVED, tabId, questionId)
  log('atv_window: permission resolved pushed', { tab_id: tabId, question_id: questionId })
}

/**
 * Push a submitted user prompt to the ATV mirror (any surface's prompt —
 * user turns never ride normalized events; the owner's optimistic insert
 * lives only in its own store). Fired from the IPC.PROMPT funnel.
 */
export function notifyAtvUserMessageEcho(tabId: string, prompt: string): void {
  const win = state.atvWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.ATV_USER_MESSAGE_ECHO, tabId, prompt)
}

/** Surface the existing ATV window (dock click / Cmd-Tab activate). */
export function focusAtvWindow(source: string): void {
  const win = state.atvWindow
  if (!win || win.isDestroyed()) return
  // Activate the APP, not just the window. An accessory→regular policy flip
  // only fully registers with the Cmd-Tab switcher / Stage Manager once the
  // app actually activates; without this, switching to the ATV bounces —
  // macOS refuses the activation and re-activates the previous app until
  // the user clicks the Dock icon.
  app.focus({ steal: true })
  win.show()
  win.focus()
  log('atv_window: focused', { source })
}

/**
 * Toggle the ATV window from its global shortcut: closed → open; open but
 * unfocused/hidden → surface; open and focused → hide (window stays alive,
 * mirroring the overlay's Alt+Space feel).
 */
export function toggleAtvWindow(source: string): void {
  const win = state.atvWindow
  if (!win || win.isDestroyed()) {
    openAtvWindow(source)
    return
  }
  if (win.isVisible() && win.isFocused()) {
    win.hide()
    log('atv_window: hidden by toggle', { source })
  } else {
    focusAtvWindow(source)
  }
}

/**
 * Open the ATV window, or focus it if it already exists. Idempotent; there is
 * never more than one ATV window. Refuses under an 'overlay-only' surface
 * policy — the single gate every launcher (tray, button, IPC, shortcut)
 * funnels through.
 */
export function openAtvWindow(source = 'unknown'): void {
  try {
    const s = readSettings()
    if (s.surfacePolicy === 'overlay-only' || s.atvBeta !== true) {
      log('atv_window: open refused', { source, surface_policy: s.surfacePolicy, atv_beta: s.atvBeta })
      return
    }
  } catch {
    // Unreadable settings: no policy, proceed.
  }
  if (state.atvWindow && !state.atvWindow.isDestroyed()) {
    focusAtvWindow(`open existing (${source})`)
    return
  }

  log('atv_window: creating', { source })
  const saved = savedAtvBounds()
  const win = new BrowserWindow({
    width: saved.width ?? ATV_DEFAULT_WIDTH,
    height: saved.height ?? ATV_DEFAULT_HEIGHT,
    ...(saved.x != null && saved.y != null ? { x: saved.x, y: saved.y } : {}),
    title: 'Ion',
    show: false,
    backgroundColor: '#14161c',
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
  state.atvWindow = win

  // Same renderer console forwarding as the main window, tagged [atv] so log
  // lines from the two renderers are distinguishable in desktop.jsonl.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) {
      _error('atv-renderer', message)
    } else if (level === 2) {
      _warn('atv-renderer', message)
    } else if (level === 0) {
      _debug('atv-renderer', message)
    } else {
      _trace('atv-renderer', message)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log('atv_window: renderer gone', { reason: details.reason, exit_code: details.exitCode })
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  win.once('ready-to-show', () => {
    if (state.atvWindow === win && !win.isDestroyed()) {
      win.show()
      applyAtvPin(isAtvPinned())
      applyAtvActivationPolicy(true)
      // Complete the accessory→regular transition (see focusAtvWindow) so
      // Ion appears in Cmd-Tab immediately, not after a Dock click.
      app.focus({ steal: true })
      win.focus()
      rearmOverlayClickThrough('atv shown')
      notifyAtvWindowState(true)
      persistAtvOpenState(true)
      log('atv_window: shown', { pinned: isAtvPinned() })
    }
  })

  win.on('resize', () => persistAtvBounds(win))
  win.on('move', () => persistAtvBounds(win))
  win.on('focus', () => {
    applyAtvFocusLevel(win, true)
    clearBeacon()
  })
  win.on('blur', () => applyAtvFocusLevel(win, false))

  win.on('closed', () => {
    if (state.atvWindow === win) {
      state.atvWindow = null
    }
    applyAtvActivationPolicy(false)
    rearmOverlayClickThrough('atv closed')
    notifyAtvWindowState(false)
    // User close clears the persisted open state; the quit path (forceQuit)
    // keeps it, so an ATV open at quit reopens on the next launch.
    if (!state.forceQuit) persistAtvOpenState(false)
    log('atv_window: closed')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = `${process.env.ELECTRON_RENDERER_URL}/atv.html`
    log('atv_window: loading dev url', { url })
    void win.loadURL(url)
  } else {
    const file = join(__dirname, '../renderer/atv.html')
    log('atv_window: loading file', { file })
    void win.loadFile(file)
  }
}

/**
 * Push the active tab (and its cached state) to the ATV window. Called by the
 * tab-focus handler on every active-tab change and by atv:get-state on open.
 */
export function notifyAtvActiveTab(tabId: string): void {
  const win = state.atvWindow
  if (!win || win.isDestroyed()) return
  const snapshot = getAtvState(tabId)
  win.webContents.send(IPC.ATV_ACTIVE_TAB, tabId, snapshot, state.atvActiveProfileId)
  log('atv_window: active tab pushed', { tab_id: tabId, agent_count: snapshot.agents.length })
}
