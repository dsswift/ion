import { app, Menu, nativeImage, session, Tray } from 'electron'
import { join } from 'path'
import { log as _log, error as _error } from './logger'
import { state, SPACES_DEBUG } from './state'
import { restartEngineDaemon } from '@ion/server/engine/engine-bootstrap'
import { localServer } from './local-server-instance'
import { openStudioWindow } from './studio-window-manager'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

/**
 * Debug-only window-state snapshotting, kept alive under SPACES_DEBUG for
 * diagnosing Studio window placement/activation issues. The overlay's
 * multi-Space toggle sequence this once instrumented is gone with the
 * overlay itself; the tray/CSP/engine-restart machinery below is what
 * survives it.
 */
export function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  log('[spaces] snapshot (studio-only build, no overlay window)', { reason })
}

export function getContentSecurityPolicy(): string {
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  if (isDev) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Graph View's force-directed layout runs off the main thread through
      // graphology-layout-forceatlas2's supervisor, which builds its worker
      // from a blob: URL. `default-src 'self'` alone refuses that, so
      // worker-src grants exactly the one additional scheme layout needs.
      "worker-src 'self' blob:",
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
    // See the dev-branch comment above: required by Graph View's layout worker.
    "worker-src 'self' blob:",
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

export function createTray(): void {
  const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  trayIcon.setTemplateImage(true)
  state.tray = new Tray(trayIcon)
  state.tray.setToolTip('Ion')
  // On Windows and Linux a tray context menu opens on right-click only; a
  // left-click raises 'click' and nothing else, so without this handler the
  // icon is inert. That matters more here than it looks: window-all-closed
  // keeps Ion resident precisely because a tray exists to bring it back, so an
  // inert icon plus a closed Studio window leaves a running app with no way
  // into it and a second launch that only hands off to the instance already
  // holding the lock. macOS opens the menu on left-click itself and is left
  // alone.
  if (process.platform === 'darwin') {
    log('tray: left-click opens the context menu (platform default)', { platform: process.platform })
  } else {
    state.tray.on('click', () => { openStudioWindow('tray click') })
    log('tray: left-click opens Ion Studio', { platform: process.platform })
  }
  state.tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Ion Studio', accelerator: 'Alt+Space', click: () => openStudioWindow('tray menu') },
      { type: 'separator' },
      // Force-restart the persistent engine daemon so it re-reads engine.json.
      // The engine reads its config once at process start; a config change needs
      // an explicit restart. This recycles the daemon in place without quitting
      // the desktop or booting the daemon out. Distinct from Quit All (which
      // boots the daemon out) and Quit Desktop (which leaves it running).
      { label: 'Restart Engine', click: () => {
        // Awaited off the click handler: restartEngineDaemon drives whichever
        // supervisor this platform uses (launchd on macOS, the Scheduled Task
        // on Windows), which is async, so the main thread and every renderer
        // IPC reply stay live while it runs. void + catch because a menu click
        // handler cannot itself be async without floating the promise.
        void restartEngineDaemon()
          .then((ok) => { log('tray: restart engine requested', { issued: ok }) })
          .catch((err: unknown) => { error('tray: restart engine failed', { error: String(err) }) })
      } },
      // spec 12: the local Studio server has its own respawn ladder,
      // independent of the engine daemon above; this is the operator's
      // manual re-arm after it reports offline{server_unreachable}.
      { label: 'Restart Local Server', click: () => {
        log('tray: restart local server requested')
        localServer.restart()
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit() } },
    ])
  )
}
