/**
 * Quit sequences: Electron's `will-quit` and the SIGUSR1 drain-quit.
 *
 * Split out of app-lifecycle.ts (600-line cap). The two handlers belong together
 * because they answer the same question differently, and getting that difference
 * wrong is what made "Quit Desktop closes the window but keeps engine sessions
 * running" untrue for every open conversation.
 */
import { app, globalShortcut } from 'electron'
import { rmSync } from 'fs'
import { join } from 'path'
import { log as _log, warn as _warn, error as _error, flushLogs } from './logger'
import { state, sessionPlane, engineBridge, fileWatchers, bashProcesses } from './state'
import { terminalManager } from './terminal-manager-instance'
import { stopTabSnapshotPolling } from './remote/snapshot-polling'
import { stopWorktreeFreshnessPoll } from './worktree/freshness-poll'
import { saveStudioTerminals } from './studio-terminal-persistence'
import { stopWatchdog } from './watchdog'
import { closeEgress } from './log-egress'
import { stopEgressTailers } from './log-egress-tailer'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

function removePidFile(): void {
  try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch { /* silent-ok: best-effort pid-file cleanup on quit */ }
}

/**
 * The teardown both SIGUSR1 branches run.
 *
 * SIGUSR1 is the full-quit signal, so the sessions do go away — but the stops
 * must be written BEFORE the daemon bootout, while the socket is still live.
 * Reversed, every `stop_session` lands on a dead socket and the daemon is killed
 * with sessions mid-teardown.
 */
async function fullQuitTeardown(flushRendererTabs: () => Promise<void>): Promise<void> {
  await flushRendererTabs()
  state.forceQuit = true
  terminalManager.destroyAll()
  sessionPlane.shutdown({ stopSessions: true })
  // Bootout the daemon so launchd does not restart it after we exit.
  await engineBridge.shutdownAndWait().catch((e) => {
    log('app_lifecycle: engine daemon bootout failed on quit', { error: e instanceof Error ? e.message : String(e) })
  })
  globalShortcut.unregisterAll()
  if (state.tray) { state.tray.destroy(); state.tray = null }
  removePidFile()
  flushLogs()
  app.exit(0)
}

export function installQuitHandlers(flushRendererTabs: () => Promise<void>): void {
  app.on('will-quit', () => {
    stopWatchdog()
    // Surface terminals (studio: namespace) persist scrollback + lifecycle
    // across restarts; conversation terminals ride tabs.json instead.
    saveStudioTerminals()
    globalShortcut.unregisterAll()
    // `will-quit` fires for BOTH quit answers, so it must not stop sessions:
    // the Quit All path already stopped them in window-manager's before-quit
    // while the socket was live, and the Quit Desktop path promised to leave
    // them running. Dropping the socket is all that is left to do here.
    sessionPlane.shutdown({ stopSessions: false })
    for (const [, entry] of fileWatchers) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.watcher.close()
    }
    fileWatchers.clear()
    if (state.tray) {
      state.tray.destroy()
      state.tray = null
    }
    stopTabSnapshotPolling()
    stopWorktreeFreshnessPoll()
    if (state.remoteTransport) {
      state.remoteTransport.stop().catch((err) => warn('app_lifecycle: remote transport stop failed on will-quit', { error: String(err) }))
      state.remoteTransport = null
    }
    removePidFile()
    flushLogs()
    // Stop tailers first so no new records arrive after we drain, then drain egress.
    stopEgressTailers()
    closeEgress().catch(() => {}) // silent-ok: terminal shutdown drain; flushLogs already ran and closeEgress logs its own flush errors
  })

  process.on('SIGUSR1', () => {
    log('SIGUSR1 received, draining active work before quit')
    const timeout = setTimeout(() => {
      void (async () => {
        log('Drain timeout (5min), force quitting')
        await fullQuitTeardown(flushRendererTabs)
      })()
    }, 5 * 60 * 1000)

    sessionPlane.drain(() => bashProcesses.size > 0).then(async () => {
      clearTimeout(timeout)
      log('All agents finished, quitting')
      await fullQuitTeardown(flushRendererTabs)
    }).catch((err) => error('app_lifecycle: drain-quit sequence failed', { error: String(err) }))
  })
}
