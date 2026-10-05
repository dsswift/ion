/**
 * The server's one shutdown sequence, whichever way it is asked to stop.
 *
 * Three callers reach it: a `lifecycle.shutdown` action from the local
 * desktop (Quit Desktop / Quit All / update restart), SIGTERM and SIGUSR1
 * from a supervisor, and the parent watchdog noticing the desktop is gone.
 * They differ in exactly one thing, `stopSessions`: Quit Desktop keeps the
 * engine's sessions running (the engine is a daemon and its ownership grace
 * window is what lets a relaunch reattach), Quit All and the drain-quit stop
 * them first, while the socket is still live, so each gets its own teardown.
 *
 * Every step is isolated: one that throws is logged and the rest still run,
 * because a persist failure must never leave a PTY or a LAN port behind. It
 * runs once; a second call joins the first.
 */
import { log as _log, warn as _warn, flushLogs } from './logger'
import { sessionPlane } from './state'
import { forceFlushTabs } from './store/session-store-force-flush'
import { saveStudioTerminals } from './persistence/studio-terminal-persistence'
import { terminalManager } from './terminal/terminal-manager-instance'
import { stopTabSnapshotPolling } from './remote/snapshot-polling'
import { stopWorktreeFreshnessPoll } from './worktree/freshness-poll'
import { stopAccountPoll } from './fleet/account-poll'
import { announceHostInstallRestart } from './environment/host-install'
import { stopGitWatcherBridge } from './remote/git-watcher-bridge'
import { stopStructuralSnapshotFeed } from './remote/structural-poll'
import { stopWatchdog } from './watchdog'
import { stopWireLatency } from './protocol/wire-latency-probe'
import { closeEgress } from '@ion/shared/log-egress'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('shutdown', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('shutdown', msg, fields)
}

export interface ShutdownRequest {
  /** Stop every engine session first (Quit All / drain-quit) or leave them running (Quit Desktop). */
  stopSessions: boolean
  /** Who asked, for the log. */
  reason: string
}

/** What `main()` returned: closing it ends the listeners. Null before boot finished. */
export interface ClosableHandle {
  close(): Promise<void>
}

let handle: ClosableHandle | null = null
let inFlight: Promise<void> | null = null

/** `main()` registers its handle here once boot completes. */
export function setShutdownHandle(next: ClosableHandle | null): void {
  handle = next
}

/** TEST ONLY: forget a previous run so the sequence can run again. */
export function _resetShutdownForTest(): void {
  handle = null
  inFlight = null
}

function step(name: string, run: () => void): void {
  try {
    run()
    log('step done', { step: name })
  } catch (err) {
    warn('step failed; continuing', { step: name, error: String(err) })
  }
}

async function stepAsync(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
    log('step done', { step: name })
  } catch (err) {
    warn('step failed; continuing', { step: name, error: String(err) })
  }
}

/**
 * Run the sequence once. Resolves when the listeners are closed; the caller
 * decides whether the process then exits (`main.ts`) or merely reports back
 * (`lifecycle.shutdown`, which replies before exiting so the desktop's wait
 * is bounded and observable).
 */
export function runServerShutdown(request: ShutdownRequest): Promise<void> {
  if (inFlight) {
    log('already shutting down; joining', { reason: request.reason })
    return inFlight
  }
  inFlight = (async () => {
    log('shutdown starting', { reason: request.reason, stop_sessions: request.stopSessions })
    // First, while the client and hub sockets are still open.
    step('announce a host install restart', announceHostInstallRestart)
    // Persist first: tabs.json carries every open conversation, and the
    // surface-terminal scrollback is what a relaunch restores.
    step('flush tabs', forceFlushTabs)
    step('save studio terminals', saveStudioTerminals)
    step('destroy terminals', () => terminalManager.destroyAll())
    step('stop snapshot polling', stopTabSnapshotPolling)
    step('stop snapshot feed', stopStructuralSnapshotFeed)
    step('stop worktree freshness poll', stopWorktreeFreshnessPoll)
    step('stop account poll', stopAccountPoll)
    step('stop git watcher bridge', stopGitWatcherBridge)
    step('stop watchdog', stopWatchdog)
    step('stop wire latency', stopWireLatency)
    // stop_session writes precede the bridge disconnect inside shutdown(),
    // so for Quit All every stop lands on a live socket.
    step('shutdown session plane', () => sessionPlane.shutdown({ stopSessions: request.stopSessions }))
    if (handle) await stepAsync('close listeners', () => handle!.close())
    log('shutdown complete', { reason: request.reason })
    // Last, after the final line above: the logger buffers non-ERROR lines for
    // up to 500 ms, and every caller exits immediately once this resolves.
    // Without the drain, 'shutdown complete' and the step lines that explain a
    // slow or failed quit were written to a buffer the process never flushed.
    await stepAsync('drain logs and egress', async () => {
      flushLogs()
      await closeEgress()
    })
  })()
  return inFlight
}
