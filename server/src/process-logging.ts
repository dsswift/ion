/**
 * This process's own logging lifecycle: the machine identity every line
 * carries, and the handlers that make a crash land in the log file instead of
 * vanishing.
 *
 * Split out of `main.ts` rather than added to it: that file is at the size cap,
 * and this is a self-contained concern with its own tests.
 */
import { error, flushLogs, initLoggerMachineIdentity, log, warn } from './logger'
import { closeEgress, configureEgress } from '@ion/shared/log-egress'
import { startEgressTailers } from '@ion/shared/log-egress-tailer'
import type { AuthHeaderProvider } from '@ion/shared/log-egress-types'
import type { ServerLoggingConfig } from './config/logging-config'
import { readServerVersion } from './server-version'

/** The engine's `oidc_token` reply shape, as `engine-bridge.request` returns it. */
export type EgressTokenRequest = (scope: string) => Promise<{ ok: boolean; error?: string; data?: { accessToken?: string } }>

const TAG = 'process-logging'

/**
 * How long a crash handler waits for the egress forwarder to drain before it
 * exits anyway. The file write is synchronous and already done by then; this
 * only covers the network hop to a remote sink, which must never hold a
 * crashing process open indefinitely.
 */
const EGRESS_DRAIN_TIMEOUT_MS = 2_000

/** Replaceable for tests, which must not take the runner's process down. */
let exitProcess: (code: number) => void = (code) => process.exit(code)

/** TEST ONLY. */
export function _setExitForTest(fn: ((code: number) => void) | null): void {
  exitProcess = fn ?? ((code) => process.exit(code))
}

/**
 * Stamp `host`, `machine_id` and the MDM identifiers onto every subsequent
 * line.
 *
 * The identity was already loaded at boot for the LAN announcement and simply
 * never handed to the logger, so every server line lacked the fields the log
 * schema documents -- and a central collector had nothing to group a machine's
 * lines by.
 */
export function applyMachineIdentity(identity: {
  host: string
  machineId: string
  mdmDeviceId: string
  mdmSerial: string
}): void {
  initLoggerMachineIdentity(identity)
  log(TAG, 'machine identity stamped on every log line', {
    resolved_host: identity.host,
    has_machine_id: identity.machineId !== '',
    has_mdm_device_id: identity.mdmDeviceId !== '',
  })
}

/**
 * Drain both sinks, then exit.
 *
 * ERROR lines are written synchronously, so the diagnostic itself is already
 * on disk when this runs; the drain is for everything buffered BEHIND it --
 * up to 500 ms of INFO and DEBUG, which is exactly the run-up a reader needs
 * to understand the crash.
 */
async function drainAndExit(code: number): Promise<void> {
  flushLogs()
  try {
    await Promise.race([
      closeEgress(),
      new Promise<void>((resolve) => setTimeout(resolve, EGRESS_DRAIN_TIMEOUT_MS).unref?.()),
    ])
  } catch (err) {
    // The file already has the crash line; a failing sink must not replace it
    // with an exception from the handler itself.
    error(TAG, 'egress drain failed during crash exit', { error: String(err) })
    flushLogs()
  }
  exitProcess(code)
}

/**
 * Record an unhandled failure before the process goes.
 *
 * Without these, a crash reached stderr only. Under the desktop that stderr is
 * re-logged at DEBUG and discarded at any higher level; in Docker or under a
 * service manager it goes to a file nobody rotates. Either way the server's own
 * log -- the file an investigation actually reads -- ended at the last healthy
 * line, which reads as a clean shutdown rather than a crash.
 *
 * Node's default for both conditions is to terminate, and that is preserved:
 * each handler exits 1 once the log is drained.
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err: Error) => {
    error(TAG, 'uncaught exception; exiting', {
      error: err.message,
      error_name: err.name,
      stack: err.stack ?? '(no stack)',
    })
    void drainAndExit(1)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    error(TAG, 'unhandled promise rejection; exiting', {
      error: err.message,
      error_name: err.name,
      stack: err.stack ?? '(no stack)',
    })
    void drainAndExit(1)
  })

  log(TAG, 'crash handlers installed', { handles: ['uncaughtException', 'unhandledRejection'] })
}

/**
 * The Authorization header each flush ships under.
 *
 * Called at flush time, not once at start-up, so the token is always fresh:
 * the engine owns the grant and mints short-lived access tokens on demand,
 * the same call the relay clients make. Signed out, unconfigured, or a failed
 * request all yield no header rather than an exception -- shipping keeps
 * working against a sink that wants none, and a sink that does want one
 * answers 401 instead of the server quietly giving up on logging.
 */
export function egressAuthHeaderProvider(
  logging: ServerLoggingConfig,
  requestToken: EgressTokenRequest,
): AuthHeaderProvider {
  return async (): Promise<Record<string, string>> => {
    if (!logging.tokenScope) return {}
    try {
      const result = await requestToken(logging.tokenScope)
      const token = result.data?.accessToken
      if (token) return { Authorization: `Bearer ${token}` }
      warn(TAG, 'egress token request returned no token; shipping without authorization', {
        scope: logging.tokenScope,
        error: result.error ?? '(none)',
      })
    } catch (err) {
      warn(TAG, 'egress token request failed; shipping without authorization', {
        scope: logging.tokenScope,
        error: String(err),
      })
    }
    return {}
  }
}

/**
 * Start this server's own log shipping, if its config asks for it.
 *
 * The shipping code was already here and nothing ever called it: every server
 * and web line reached a forwarder with no destination and was dropped, and
 * `server.jsonl` was the one surface no collector read. A server therefore
 * logged perfectly to a file on its own host and nowhere else -- which is
 * invisible in exactly the deployment that needs it most, a container whose
 * filesystem goes away with the pod.
 *
 * Absent config is a complete no-op, matching the engine: a server ships only
 * because an operator asked it to.
 */
export function initServerEgress(
  logging: ServerLoggingConfig,
  requestToken: EgressTokenRequest,
): void {
  if (!logging.egress) {
    log(TAG, 'no log egress configured; this server ships nothing', { ship_sources: logging.shipSources })
    return
  }

  const headerProvider = egressAuthHeaderProvider(logging, requestToken)

  const sources = logging.shipSources
  configureEgress(logging.egress, headerProvider, {
    // `server` in the matrix means this process's own records, which ship
    // in-process rather than through a tailer.
    shipOwnRecords: sources.includes('server'),
    source: 'settings',
    process: 'server',
    version: readServerVersion(),
  })
  // Never itself: server.jsonl is what shipOwnRecords already covers, and
  // tailing it would ship every line twice.
  const tailed = sources.filter((s) => s !== 'server')
  if (tailed.length > 0) startEgressTailers(tailed)
  log(TAG, 'log egress configured', {
    targets: logging.egress.egressTargets,
    endpoint: logging.egress.egressEndpoint,
    ship_sources: sources,
    tailed_sources: tailed,
    token_scope: logging.tokenScope,
  })
}
