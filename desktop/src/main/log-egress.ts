/**
 * log-egress.ts — desktop operational-log egress forwarder.
 *
 * Mirrors the engine's EgressForwarder (engine/internal/utils/log_egress.go)
 * in TypeScript. When logging.egressTargets is non-empty in engine.json, every
 * log line written by logger.ts is also buffered here and flushed periodically
 * (and on shutdown) to the configured sinks.
 *
 * Two sink types match the engine's implementations:
 *   "http"  — POST a JSON array of log records to EgressEndpoint.
 *   "otel"  — Export as OTLP log records to EgressOtel.endpoint + "/v1/logs".
 *
 * Disk spool: when a flush fails (sink unreachable or non-2xx), the batch is
 * appended to ~/.ion/.egress-spool.jsonl. On the next flush tick the spool is
 * drained first (FIFO) before the live buffer. Cap (egressSpoolMaxBytes, default
 * 50 MB) trims oldest lines. Exponential backoff prevents hot-looping.
 *
 * Auth header seam: the forwarder calls an injected async function
 * `getAuthHeaders(): Promise<Record<string, string>>` to obtain headers at
 * send time. Part E wires in a no-op provider; Part F fills it with the
 * Entra OIDC token.
 *
 * Non-blocking: ship() acquires only the forwarder's own mutex and returns
 * immediately. It never holds the logger's write path.
 */

import { randomBytes } from 'crypto'
import { log as _log } from './logger'
import { EgressForwarder, DEFAULT_FLUSH_INTERVAL_MS } from './log-egress-forwarder'
import { noopHeaderProvider } from './log-egress-types'
import type { EgressRecord, EgressConfig, AuthHeaderProvider } from './log-egress-types'
import { _resetSpoolStateForTest } from './log-egress-spool'

// The types and the forwarder live in sibling modules; re-exported here so
// this module stays the single public entry point for the egress subsystem.
export type {
  EgressRecord,
  EgressOtelConfig,
  EgressConfig,
  AuthHeaderProvider,
} from './log-egress-types'
export { noopHeaderProvider } from './log-egress-types'
export { EgressForwarder } from './log-egress-forwarder'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress', msg, fields)
}

// ---------------------------------------------------------------------------
// Module-level singleton and public API
// ---------------------------------------------------------------------------

/**
 * User-attribution context. Set from the signed-in Entra identity at startup
 * and updated whenever the user signs in or out. When set, this value is
 * stamped onto every EgressRecord shipped via shipToEgress (F4).
 */
let _egressUser: string | undefined

/**
 * Set (or clear) the user-attribution field on outbound egress records.
 * Call with the preferred_username / oid claim after Entra sign-in, and
 * with undefined after sign-out.
 */
export function setEgressUser(user: string | undefined): void {
  _egressUser = user
  log('egress user context updated', { user: user ?? '(cleared)' })
}

/** Returns the current egress user claim, or undefined if not signed in. */
export function getEgressUser(): string | undefined {
  return _egressUser
}

let activeForwarder: EgressForwarder | null = null

/**
 * Shipping-responsibility gate for the desktop's OWN records (matrix
 * source "desktop"). Tailed sources bypass it via shipTailedToEgress — a
 * forwarder may exist solely to ship tailed files. Default true preserves
 * legacy behavior for callers that don't pass options.
 */
let _shipOwnRecords = true

/**
 * Configure the module-level egress forwarder. Call once at startup (after
 * reading engine.json). Passing a config with empty egressTargets (or calling
 * without arguments) is a no-op — the default install is completely unchanged.
 *
 * @param cfg    Egress config sourced from engine.json LoggingConfig.
 * @param getAuthHeaders  Pluggable header provider. Defaults to noopHeaderProvider;
 *                        production wires the engine-minted OIDC token fetcher.
 * @param opts   shipOwnRecords: whether the shipping matrix assigns source
 *               "desktop" to this surface (default true — legacy behavior).
 */
export function configureEgress(
  cfg?: EgressConfig,
  getAuthHeaders: AuthHeaderProvider = noopHeaderProvider,
  opts?: { shipOwnRecords?: boolean },
): void {
  if (activeForwarder) {
    // Drain the old forwarder asynchronously. flush() failures are logged by
    // logFlushError; a rejection of close() itself (e.g. the shutdown promise)
    // would otherwise be silent, so log it explicitly.
    activeForwarder.close().catch((err) => {
      log('egress forwarder close failed during reconfigure', { error: String(err) })
    })
    activeForwarder = null
  }
  _shipOwnRecords = opts?.shipOwnRecords ?? true
  if (!cfg || cfg.egressTargets.length === 0) return
  activeForwarder = new EgressForwarder(cfg, getAuthHeaders)
  log('egress forwarder configured', {
    targets: cfg.egressTargets,
    endpoint: cfg.egressEndpoint,
    flush_interval_ms: cfg.egressFlushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    batch_size: cfg.egressBatchSize ?? 0,
    ship_own_records: _shipOwnRecords,
  })
}

/**
 * Enqueue a single desktop log record for egress. No-op when no forwarder
 * is active (default install) or when the shipping matrix assigns source
 * "desktop" to another surface. Called from logger.ts's logAt path so it
 * must never block.
 *
 * Stamps the user-attribution field (F4) when an Entra identity is present.
 */
export function shipToEgress(rec: EgressRecord): void {
  if (!activeForwarder || !_shipOwnRecords) return
  enqueueRecord(rec)
}

/**
 * Enqueue a record read from a tailed source file (matrix sources
 * "engine" / "ios" / "telemetry"). Bypasses the own-records gate so a
 * desktop assigned only tailed sources still ships them.
 */
export function shipTailedToEgress(rec: EgressRecord): void {
  if (!activeForwarder) return
  enqueueRecord(rec)
}

function enqueueRecord(rec: EgressRecord): void {
  if (!activeForwarder) return
  // Stamp a per-record event_id when absent (downstream-dedup key). Byte-shape
  // parity with the engine forwarder, which stamps at its own enqueue funnel.
  const stamped: EgressRecord = rec.event_id ? rec : { ...rec, event_id: genEventID() }
  if (_egressUser && !stamped.user) {
    activeForwarder.ship({ ...stamped, user: _egressUser })
  } else {
    activeForwarder.ship(stamped)
  }
}

/**
 * genEventID returns a 16-hex-char (8 random bytes) unique record identifier,
 * matching the engine's utils.GenEventID / telemetry event_id shape.
 */
function genEventID(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Drain all buffered egress records and stop the forwarder. Called from
 * app-lifecycle.ts on will-quit, after flushLogs(), to guarantee every log
 * line that reached the file also reached the egress sink.
 */
export async function closeEgress(): Promise<void> {
  if (!activeForwarder) return
  const f = activeForwarder
  activeForwarder = null
  await f.close()
}

/**
 * Flush buffered egress records without closing the forwarder. Primarily used
 * in tests; production code uses closeEgress() for the final drain.
 */
export async function flushEgress(): Promise<void> {
  if (!activeForwarder) return
  await activeForwarder.flush()
}

/**
 * TEST ONLY. Current live-buffer depth, for asserting the MAX_BUFFER_RECORDS
 * bound. Returns 0 when no forwarder is configured.
 */
export function _getBufferLengthForTest(): number {
  return activeForwarder?._bufferLengthForTest() ?? 0
}

/**
 * TEST ONLY. Reset module-level forwarder state between test cases.
 */
export function _resetEgressForTest(): void {
  if (activeForwarder) {
    activeForwarder.close().catch(() => {}) // silent-ok: test-only reset helper (_resetEgressForTest)
    activeForwarder = null
  }
  _egressUser = undefined
  _shipOwnRecords = true
  _resetSpoolStateForTest()
}
