/**
 * Desktop log-level resolution.
 *
 * Split from app-lifecycle so the startup file stays under the size cap and so
 * the level policy — which is a small, testable decision — is not buried in
 * window and dock wiring.
 *
 * ── Why the default is DEBUG ────────────────────────────────────────────────
 * The packaged build has no DevTools, so `~/.ion/desktop.jsonl` is the only
 * diagnostic channel there is. With INFO-only logging, a `rDebug` line placed
 * specifically to explain a scroll or measurement decision is filtered out —
 * and its absence reads as "that code path never ran", which sends the reader
 * after the wrong cause. Verbose-but-present beats terse-and-blind on a
 * development machine.
 *
 * TRACE is available but deliberately not the default: per-frame diagnostics
 * are loud enough to rotate away the very window that holds the evidence.
 */
import { log as _log, setLogLevel, type LogLevel } from './logger'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'

const LOG_LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']

/**
 * Read the configured level and apply it to the logger.
 *
 * Every failure path keeps the logger's compiled-in default rather than
 * throwing: a bad settings value must never be able to stop logging, because
 * that would hide its own cause.
 */
export function applyConfiguredLogLevel(): void {
  let configured: unknown
  try {
    // `readSettings` returns the FILE as written — it does not merge
    // SETTINGS_DEFAULTS. A key the operator has never toggled is simply
    // absent, so the default must be applied here, exactly as every other
    // consumer of an optional setting does it. Reading the raw value alone
    // meant the DEBUG default never applied to any existing install: the key
    // was missing, the resolver saw `undefined`, and logging silently stayed
    // at INFO on the one machine that most needed DEBUG.
    configured = readSettings().logLevel ?? SETTINGS_DEFAULTS.logLevel
  } catch (err) {
    // Settings unreadable this early is survivable — apply the default rather
    // than leaving the logger at whatever it was compiled with.
    _log('logger', 'settings unreadable; applying default log level', { error: String(err) })
    configured = SETTINGS_DEFAULTS.logLevel
  }

  const level = LOG_LEVELS.find((candidate) => candidate === configured)
  if (!level) {
    _log('logger', 'log level not recognized; keeping default', {
      configured: String(configured),
      supported: LOG_LEVELS.join(','),
    })
    return
  }

  setLogLevel(level)
  _log('logger', 'log level applied', { level })
}
