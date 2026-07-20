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

import { log as _log } from './logger'
import { flushToOtel } from './log-egress-otel'
import {
  appendToSpool,
  readSpool,
  rewriteSpoolRemainder,
  hasSpoolContent,
  isInBackoff,
  advanceBackoff,
  resetBackoff,
  DEFAULT_SPOOL_MAX_BYTES,
  _resetSpoolStateForTest,
} from './log-egress-spool'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress', msg, fields)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * EgressRecord is the structured payload shipped to downstream egress targets.
 * Mirrors the canonical log schema (docs/observability/log-schema.md) so the
 * egress stream is parseable by the same tooling as the local JSONL file.
 *
 * The type is intentionally lenient (string | undefined) so verbatim records
 * from the engine or iOS tails (which may have additional fields) round-trip
 * without truncation — the extra fields survive in the spread.
 */
export interface EgressRecord {
  ts: string
  level: string
  msg: string
  component: string
  tag?: string
  session_id?: string
  conversation_id?: string
  trace_id?: string
  /**
   * User-attribution field (schema v3 — commit ed7e4b9c).
   * Set from the signed-in Entra identity (preferred_username claim, or
   * oid fallback). Omitted when no user is signed in (unauthenticated
   * telemetry is still accepted by a no-auth sink). See entra-auth.ts
   * for the claim-selection rationale.
   */
  user?: string
  fields?: Record<string, unknown>
  [key: string]: unknown
}

/** Minimal OtelConfig shape needed by the forwarder (mirrors engine types.OtelConfig). */
export interface EgressOtelConfig {
  endpoint: string
  serviceName?: string
  headers?: Record<string, string>
}

/** Full egress config, sourced from engine.json LoggingConfig egress fields. */
export interface EgressConfig {
  /** Downstream shipping targets. "http" | "otel" (or both). */
  egressTargets: string[]
  /** HTTP POST URL for the "http" target. */
  egressEndpoint?: string
  /** Static headers for the "http" target (static per-config, not the auth seam). */
  egressHeaders?: Record<string, string>
  /** How many records to buffer before triggering an automatic flush. 0 = ticker only. */
  egressBatchSize?: number
  /** Flush interval in ms. Default 5000. */
  egressFlushIntervalMs?: number
  /** OTLP config for the "otel" target. */
  egressOtel?: EgressOtelConfig
  /**
   * Cap the on-disk spool file in bytes. When the spool exceeds this size,
   * the oldest lines are trimmed. Zero uses the default (50 MB).
   */
  egressSpoolMaxBytes?: number
}

/**
 * Pluggable auth-header provider. Called at send time so the token is always
 * fresh. Returns a map of headers to merge into the request (e.g.
 * { Authorization: "Bearer <token>" }).
 *
 * Part E wires in noopHeaderProvider (returns {}). Part F replaces this with
 * an Entra OIDC token provider.
 */
export type AuthHeaderProvider = () => Promise<Record<string, string>>

/** No-op provider for Part E — returns empty headers (no auth). */
export const noopHeaderProvider: AuthHeaderProvider = () => Promise.resolve({})

// ---------------------------------------------------------------------------
// Sink helpers
// ---------------------------------------------------------------------------

async function flushToHTTP(
  records: EgressRecord[],
  endpoint: string,
  staticHeaders: Record<string, string>,
  authHeaders: Record<string, string>,
): Promise<void> {
  if (!endpoint) throw new Error('log egress HTTP endpoint not configured')
  const body = JSON.stringify(records)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...staticHeaders,
      ...authHeaders,
    },
    body,
  })
  if (res.status >= 400) {
    throw new Error(`log egress http: POST returned status ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
// EgressForwarder
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 5_000

/**
 * Maximum records shipped in a single spool-drain POST. The spool is drained in
 * bounded batches of this size, oldest-first, persisting the un-shipped
 * remainder after each batch.
 *
 * Why this exists: the original drain read the ENTIRE spool and shipped it as
 * one request. Once the spool outgrew what a single request could deliver
 * (collector payload cap or request timeout), that one oversized POST failed on
 * every tick, the drain returned before the live buffer, and the spool never
 * cleared — a 75 MB / ~246k-line permanent wedge. Bounding each drain to a
 * deliverable batch means a large backlog drains steadily over many ticks
 * instead of failing forever as an indivisible blob.
 */
const SPOOL_DRAIN_BATCH_RECORDS = 500

/**
 * EgressForwarder buffers operational log lines and ships them to one or more
 * downstream targets ("http", "otel"). Constructed by newEgressForwarder and
 * stored as a module-level singleton (activeForwarder) set by configureEgress.
 *
 * The forwarder is non-blocking: ship() appends to the buffer and returns. The
 * periodic flush and batch-size triggers run asynchronously and never hold the
 * logger's write path.
 */
export class EgressForwarder {
  private readonly cfg: EgressConfig
  private readonly getAuthHeaders: AuthHeaderProvider

  // Buffer protected by a boolean "locked" flag instead of an actual mutex —
  // JavaScript is single-threaded; async flushes are interleaved at await
  // points. We swap the buffer out atomically before any await.
  private buffer: EgressRecord[] = []

  // Dedup flush-error log lines (one log per distinct error string, mirrors Go).
  private readonly loggedErrors = new Set<string>()

  private ticker: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private shutdownResolve: (() => void) | null = null
  private flushInProgress = false

  constructor(cfg: EgressConfig, getAuthHeaders: AuthHeaderProvider = noopHeaderProvider) {
    this.cfg = {
      ...cfg,
      egressFlushIntervalMs: cfg.egressFlushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS,
    }
    this.getAuthHeaders = getAuthHeaders

    const intervalMs = this.cfg.egressFlushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.ticker = setInterval(() => { this.flushAsync() }, intervalMs)
    // Unref so the ticker doesn't keep the Node process alive.
    if (this.ticker && typeof this.ticker === 'object' && 'unref' in this.ticker) {
      (this.ticker as NodeJS.Timeout).unref()
    }
  }

  /**
   * Enqueue a log record. Non-blocking — returns immediately. Called from the
   * logger's write path and must never block.
   */
  ship(rec: EgressRecord): void {
    if (this.stopped) return
    this.buffer.push(rec)

    const batchSize = this.cfg.egressBatchSize ?? 0
    if (batchSize > 0 && this.buffer.length >= batchSize) {
      this.flushAsync()
    }
  }

  /**
   * Flush all buffered records to configured egress targets. Resolves when all
   * targets have been attempted (errors are logged but do not reject).
   *
   * Order: drain spool in bounded batches (FIFO) first, then ship the live
   * buffer. On failure the live buffer batch is appended to the spool for the
   * next attempt.
   */
  async flush(): Promise<void> {
    // Respect exponential backoff from previous sink failures.
    if (isInBackoff()) {
      log('flush skipped: in backoff', { buffered: this.buffer.length })
      return
    }

    // --- Drain spool (bounded FIFO batch) ---
    // Ship at most SPOOL_DRAIN_BATCH_RECORDS oldest records per tick, then
    // persist the un-shipped remainder. A large backlog drains over many ticks
    // instead of failing forever as one oversized, undeliverable request.
    if (hasSpoolContent()) {
      const spoolLines = readSpool()
      const totalSpooled = spoolLines.length
      if (totalSpooled > 0) {
        const batchLines = spoolLines.slice(0, SPOOL_DRAIN_BATCH_RECORDS)
        const remainderLines = spoolLines.slice(SPOOL_DRAIN_BATCH_RECORDS)

        const spoolRecords: EgressRecord[] = []
        let parseSkipped = 0
        for (const line of batchLines) {
          try {
            spoolRecords.push(JSON.parse(line) as EgressRecord)
          } catch {
            // Malformed spooled line — drop it from the batch. It is excluded
            // from the remainder below (we write back only remainderLines), so
            // a single un-parseable record can never wedge the drain.
            parseSkipped++
          }
        }

        log('spool drain attempt', {
          total_spooled: totalSpooled,
          batch_records: spoolRecords.length,
          parse_skipped: parseSkipped,
          remainder_after_batch: remainderLines.length,
        })

        if (spoolRecords.length > 0) {
          const authHeaders = await this.getAuthHeadersSafe()
          const staticHeaders = this.cfg.egressHeaders ?? {}
          let spoolFailed = false
          for (const target of this.cfg.egressTargets) {
            try {
              if (target === 'http') {
                await flushToHTTP(spoolRecords, this.cfg.egressEndpoint ?? '', staticHeaders, authHeaders)
              } else if (target === 'otel') {
                if (this.cfg.egressOtel) {
                  await flushToOtel(spoolRecords, this.cfg.egressOtel, authHeaders)
                }
              }
            } catch (err) {
              spoolFailed = true
              this.logFlushError(`spool-drain ${target}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          if (spoolFailed) {
            log('spool drain batch failed; leaving spool intact', {
              batch_records: spoolRecords.length,
              total_spooled: totalSpooled,
            })
            advanceBackoff()
            return // leave spool on disk; don't send live buffer into it
          }
          // Batch shipped. Persist the un-shipped remainder (drops the shipped
          // batch AND any malformed lines in it). Empty remainder deletes the
          // spool. resetBackoff so the next batch fires on the next tick.
          rewriteSpoolRemainder(remainderLines)
          resetBackoff()
          log('spool drain batch shipped', {
            shipped: spoolRecords.length,
            parse_skipped: parseSkipped,
            remainder: remainderLines.length,
          })
          // If a remainder is on disk, it will be drained on the next tick.
          // Execution falls through to the live-buffer section so live records
          // are never starved behind a large backlog — each tick ships one
          // bounded spool batch AND the live buffer (two POSTs max per tick).
        } else {
          // Every line in the batch was malformed. Drop them (write back the
          // remainder) so the drain makes forward progress instead of retrying
          // an un-parseable prefix forever. Execution falls through to the
          // live-buffer section — live records are not starved by a malformed spool.
          rewriteSpoolRemainder(remainderLines)
          log('spool drain batch had no parseable records; dropped', {
            dropped: parseSkipped,
            remainder: remainderLines.length,
          })
        }
      }
    }

    // --- Live buffer ---
    if (this.buffer.length === 0) return

    const records = this.buffer
    this.buffer = []

    const authHeaders = await this.getAuthHeadersSafe()
    const staticHeaders = this.cfg.egressHeaders ?? {}

    log('live buffer flush attempt', { records: records.length })

    let anyFailed = false
    for (const target of this.cfg.egressTargets) {
      try {
        if (target === 'http') {
          await flushToHTTP(records, this.cfg.egressEndpoint ?? '', staticHeaders, authHeaders)
        } else if (target === 'otel') {
          if (this.cfg.egressOtel) {
            await flushToOtel(records, this.cfg.egressOtel, authHeaders)
          } else {
            this.logFlushError('log egress otel: egressOtel config missing')
          }
        }
      } catch (err) {
        anyFailed = true
        this.logFlushError(`${target}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (anyFailed) {
      // Spool undeliverable batch.
      const maxBytes = this.cfg.egressSpoolMaxBytes || DEFAULT_SPOOL_MAX_BYTES
      const lines = records.map((r) => JSON.stringify(r))
      appendToSpool(lines, maxBytes)
      advanceBackoff()
      log('live buffer flush failed; spooled batch', { spooled: lines.length })
    } else {
      resetBackoff()
      log('live buffer flush shipped', { shipped: records.length })
    }
  }

  /** Safely retrieve auth headers, returning {} on provider error. */
  private async getAuthHeadersSafe(): Promise<Record<string, string>> {
    try {
      return await this.getAuthHeaders()
    } catch (err) {
      this.logFlushError(`auth header provider failed: ${err instanceof Error ? err.message : String(err)}`)
      return {}
    }
  }

  /**
   * Fire-and-forget flush. Used by the ticker and batch-size trigger so the
   * write path is never awaited. Prevents concurrent flushes via a flag.
   */
  private flushAsync(): void {
    if (this.flushInProgress) return
    this.flushInProgress = true
    void this.flush().finally(() => {
      this.flushInProgress = false
      if (this.stopped && this.shutdownResolve) {
        this.shutdownResolve()
        this.shutdownResolve = null
      }
    })
  }

  /**
   * Stop the periodic ticker, drain remaining buffered records, and resolve
   * when the drain flush completes. Safe to call multiple times (idempotent
   * after the first call).
   */
  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true

    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }

    // Drain the buffer. If a flush is in-progress, wait for it to finish
    // then run one final flush via the shutdownResolve mechanism; otherwise
    // flush directly.
    if (this.flushInProgress) {
      await new Promise<void>((resolve) => {
        this.shutdownResolve = resolve
      })
    }

    // Final drain: any records that arrived between the in-progress flush swap
    // and our stop flag.
    await this.flush()
  }

  private logFlushError(msg: string): void {
    if (this.loggedErrors.has(msg)) return
    this.loggedErrors.add(msg)
    log('egress flush failed (subsequent identical errors suppressed)', {
      targets: this.cfg.egressTargets,
      error: msg,
    })
  }
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
  if (_egressUser && !rec.user) {
    activeForwarder.ship({ ...rec, user: _egressUser })
  } else {
    activeForwarder.ship(rec)
  }
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
