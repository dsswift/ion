/**
 * Quit sequences: the operator-facing quit dialog, Electron's `will-quit`,
 * the SIGUSR1 drain-quit, and the forced quit (SIGUSR2, or FORCE_QUIT_ARG on
 * Windows).
 *
 * Split out of app-lifecycle.ts (600-line cap). The three handlers belong
 * together because they answer the same question differently, and getting
 * that difference wrong is what made "Quit Desktop closes the window but
 * keeps engine sessions running" untrue for every open conversation.
 *
 * The sessions, PTYs, device transport and background jobs live in the
 * Studio server child, so every quit is carried out THERE
 * (`server/src/shutdown.ts`) through one `lifecycle.shutdown` action; this
 * process only decides the answer, waits for the server's reply (bounded,
 * with the child's own exit as the other race arm), then tears down what is
 * genuinely its own: the engine daemon for Quit All, shortcuts, the tray,
 * the pid file, log egress. The ordering the old in-process quit encoded --
 * stop sessions while the engine socket is live, then boot out the daemon --
 * survives the process boundary because the server replies only after its
 * session plane has shut down.
 */
import { app, dialog, globalShortcut } from 'electron'
import { localServer } from './local-server-instance'
import { sshTunnels } from './connections/ssh/ssh-tunnel-instance'
import { rmSync } from 'fs'
import { join } from 'path'
import { log as _log, warn as _warn, error as _error, flushLogs } from './logger'
import { state } from './state'
import { broker } from './connections/broker-instance'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { stopEngineDaemon } from '@ion/server/engine/engine-bootstrap'
import { waitForEngineStopped } from '@ion/server/engine/engine-address'
import { stopWatchdog } from '@ion/server/watchdog'
import { closeEgress } from '@ion/shared/log-egress'
import { stopEgressTailers } from '@ion/shared/log-egress-tailer'
import { FORCE_QUIT_ARG } from './force-quit-arg'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

/** How long the quit dialog waits to learn whether sessions are running before assuming they are. */
export const STATUS_TIMEOUT_MS = 3000
/** How long a quit waits for the server's shutdown reply (or its exit) before proceeding regardless. */
export const SHUTDOWN_TIMEOUT_MS = 15_000
/** How long Quit All waits for the engine to stop answering after the supervisor was told to stop it. */
export const ENGINE_STOP_TIMEOUT_MS = 3000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      warn('wait timed out; proceeding', { label, timeout_ms: ms })
      resolve('timeout')
    }, ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (err) => { clearTimeout(timer); reject(err) })
  })
}

function removePidFile(): void {
  try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch { /* silent-ok: best-effort pid-file cleanup on quit */ }
}

/** The desktop's own teardown, after the server is gone. Every quit path ends here. */
function desktopTeardown(): void {
  globalShortcut.unregisterAll()
  if (state.tray) {
    state.tray.destroy()
    state.tray = null
  }
  removePidFile()
  flushLogs()
  stopEgressTailers()
  closeEgress().catch(() => {}) // silent-ok: terminal shutdown drain; flushLogs already ran and closeEgress logs its own flush errors
}

/** Quit Desktop / Quit All, carried out by the server. `stopSessions` is the whole distinction. */
/** Whether the local server can be asked anything right now: its wire is open. */
function localWireOpen(): boolean {
  return broker.phaseOf(LOCAL_ENVIRONMENT_ID)?.phase === 'connected'
}

let quitInFlight: Promise<void> | null = null

/** TEST ONLY. */
export function _resetQuitForTest(): void {
  quitInFlight = null
}

export function quitThroughServer(opts: { stopSessions: boolean }): Promise<void> {
  // A second request (the splash Quit clicked again, a tray Quit during the
  // dialog) joins the quit already underway instead of racing it.
  if (quitInFlight) {
    log('quit: already in flight; joining', { stop_sessions: opts.stopSessions })
    return quitInFlight
  }
  quitInFlight = runQuitThroughServer(opts)
  return quitInFlight
}

async function runQuitThroughServer(opts: { stopSessions: boolean }): Promise<void> {
  // Set this first: no normal quit confirmation may interpose once a quit is
  // underway, even if the server needs time.
  state.forceQuit = true
  if (localWireOpen()) {
    log('quit: asking the local server to shut down', { stop_sessions: opts.stopSessions })
    const reply = withTimeout(
      Promise.race([
        broker.sendAction(LOCAL_ENVIRONMENT_ID, 'lifecycle.shutdown', [{ stopSessions: opts.stopSessions }]).then(() => 'replied' as const),
        localServer.waitForExit().then(() => 'exited' as const),
      ]),
      SHUTDOWN_TIMEOUT_MS,
      'server shutdown',
    )
    try {
      log('quit: server shutdown outcome', { outcome: await reply })
    } catch (err) {
      warn('quit: server shutdown action failed; proceeding with the desktop teardown', { error: String(err) })
    }
  } else {
    // Nothing to ask: the server never came up, or its wire is down. A
    // frame would only queue until every timeout expired -- the 20-second
    // quit the splash's Quit button once produced.
    log('quit: local wire not open; stopping the server child directly', { stop_sessions: opts.stopSessions })
  }
  await localServer.stop()
  if (opts.stopSessions) {
    // Quit All: the sessions were stopped by the server while its engine
    // socket was live; now boot out the daemon so the supervisor does not
    // bring it back, and wait until it stops answering.
    log('Quit All: stopping the engine daemon')
    await stopEngineDaemon().catch((err: unknown) => warn('quit: engine daemon stop failed, proceeding', { error: String(err) }))
    const stopped = await waitForEngineStopped(ENGINE_STOP_TIMEOUT_MS).catch(() => false)
    log('Quit All: engine stop wait finished', { stopped })
  }
  desktopTeardown()
  app.exit(0)
}

/**
 * Quit immediately after an update worker has staged the replacement bundle.
 * Restart is an explicit instruction: it stops sessions and the engine
 * before exiting, and `state.forceQuit` bypasses the quit dialog.
 */
export async function quitForUpdate(): Promise<void> {
  log('update restart requested; stopping desktop and engine')
  await quitThroughServer({ stopSessions: true })
}

/** Whether engine sessions are running, from the server; unknown reads as "running" so the dialog errs toward the fuller warning. */
async function sessionsRunning(): Promise<boolean> {
  if (!localWireOpen()) {
    log('quit: local wire not open; no sessions to ask about')
    return false
  }
  try {
    const status = await withTimeout(broker.sendAction(LOCAL_ENVIRONMENT_ID, 'lifecycle.status', []), STATUS_TIMEOUT_MS, 'lifecycle.status')
    if (status === 'timeout') return true
    return (status as { hasRunningTabs?: boolean } | null)?.hasRunningTabs === true
  } catch (err) {
    warn('quit: lifecycle.status failed; assuming sessions are running', { error: String(err) })
    return true
  }
}

/**
 * The operator-facing "Quit Desktop / Quit All / Cancel" prompt, shown on
 * every quit attempt (tray Quit, Cmd+Q, window close) when sessions may be
 * running. Parented to the Studio window, the one window that exists.
 *
 * 0 = Quit Desktop (engine keeps running), 1 = Quit All (engine shuts down
 * too), 2 = Cancel.
 */
export function installBeforeQuitDialog(): void {
  app.on('before-quit', (e) => {
    if (state.forceQuit) return
    e.preventDefault()
    void (async () => {
      const hasRunning = await sessionsRunning()
      const dialogOptions = {
        type: 'question' as const,
        buttons: ['Quit Desktop', 'Quit All', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
        title: 'Quit Ion?',
        message: hasRunning
          ? 'Sessions are running in the engine.'
          : 'How would you like to quit?',
        detail: hasRunning
          ? 'Quit Desktop closes the window but keeps engine sessions running.\nQuit All stops the engine and all running sessions.'
          : 'Quit Desktop closes the window but keeps the engine running.\nQuit All stops the engine too.',
      }
      const choice = state.studioWindow && !state.studioWindow.isDestroyed()
        ? dialog.showMessageBoxSync(state.studioWindow, dialogOptions)
        : dialog.showMessageBoxSync(dialogOptions)
      if (choice === 2) {
        log('quit: cancelled by the operator')
        return
      }
      await quitThroughServer({ stopSessions: choice === 1 })
    })().catch((err) => error('quit: dialog sequence failed', { error: String(err) }))
  })
}

export function installQuitHandlers(): void {
  installBeforeQuitDialog()
  app.on('will-quit', () => {
    stopWatchdog()
    broker.latency.stop()
    // The safety net for the `app.quit()` paths that never came through the
    // dialog: the child is asked to stop the same way, and this process does
    // not wait on it -- the parent watchdog in the child covers a desktop
    // that is already gone. `app.exit()` paths never reach `will-quit` and
    // stop the child themselves in quitThroughServer.
    log('will-quit: stopping the local server as a safety net')
    void localServer.stop().catch((err) => warn('will-quit: local server stop failed', { error: String(err) }))
    sshTunnels.stopAll()
    desktopTeardown()
  })

  // The drain-quit (`make desktop`): the server drains active work, stops
  // the sessions and exits on its own SIGUSR1 handler; this process waits
  // for that exit without a timeout, then boots the engine out and quits.
  process.on('SIGUSR1', () => {
    log('SIGUSR1 received; asking the local server to drain active work before quitting')
    state.forceQuit = true
    void (async () => {
      if (localServer.signal('SIGUSR1')) await localServer.waitForExit()
      await stopEngineDaemon().catch((err: unknown) => warn('drain-quit: engine daemon stop failed, proceeding', { error: String(err) }))
      await waitForEngineStopped(ENGINE_STOP_TIMEOUT_MS).catch(() => false)
      log('drain-quit: all work finished, quitting')
      desktopTeardown()
      app.exit(0)
    })().catch((err) => error('app_lifecycle: drain-quit sequence failed', { error: String(err) }))
  })

  // The forced quit (a remote deploy with nobody at the keyboard): the same
  // Quit All the update restart performs, asked for by signal. No dialog is
  // shown, so there is nothing for an absent operator to approve, and active
  // work is stopped rather than waited on, so the quit ends in bounded time.
  process.on('SIGUSR2', () => forcedQuit('SIGUSR2'))
  // Windows has no signals: the same forced quit arrives as a second launch
  // carrying FORCE_QUIT_ARG.
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(FORCE_QUIT_ARG)) forcedQuit('second launch with ' + FORCE_QUIT_ARG)
  })
}

function forcedQuit(trigger: string): void {
  log('forcing a quit: dialog bypassed, sessions and engine stopped', { trigger })
  void quitThroughServer({ stopSessions: true })
    .catch((err) => error('app_lifecycle: forced quit sequence failed', { error: String(err) }))
}
