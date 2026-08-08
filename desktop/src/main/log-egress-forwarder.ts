/**
 * log-egress-forwarder.ts — the EgressForwarder class and its sink helpers.
 *
 * Split from log-egress.ts (600-line cap). log-egress.ts owns the module-level
 * singleton and the public API; this file owns the buffering, flushing, and
 * spool-interaction mechanics behind it.
 *
 * Two caps bound this subsystem, and they bound different resources: the spool
 * cap (egressSpoolMaxBytes, enforced in log-egress-spool.ts) bounds DISK, and
 * MAX_BUFFER_RECORDS below bounds HEAP. A sink that fails indefinitely must
 * grow neither.
 */

import { log as _log, error as _error } from './logger'
import { flushToOtel } from './log-egress-otel'
import { noopHeaderProvider } from './log-egress-types'
import type { EgressRecord, EgressConfig, AuthHeaderProvider } from './log-egress-types'
import {
  appendToSpool,
  readSpool,
  rewriteSpoolRemainder,
  hasSpoolContent,
  isInBackoff,
  advanceBackoff,
  resetBackoff,
  DEFAULT_SPOOL_MAX_BYTES,
} from './log-egress-spool'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('log_egress', msg, fields)
}


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

export const DEFAULT_FLUSH_INTERVAL_MS = 5_000

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
 * Maximum records held in the in-memory live buffer. Overflow evicts
 * oldest-first and is reported at ERROR.
 *
 * The spool cap bounds DISK; this bounds HEAP. Every path that skips the live
 * buffer — an active backoff window, a failed spool-drain batch — returns
 * while ship() keeps appending, so a sink that fails indefinitely grows this
 * array without limit. That is the same failure the spool cap exists to
 * prevent, relocated into RAM: the engine's equivalent buffer reached 9.5 GB
 * against an OTLP sink that returned 401 for days. At ~350 bytes per record
 * 50k records is ~17 MB — enough to ride out a multi-minute outage without
 * loss, bounded enough that a permanent one cannot exhaust memory.
 */
const MAX_BUFFER_RECORDS = 50_000

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

  // Records evicted from the live buffer at MAX_BUFFER_RECORDS. Reported from
  // flush(), never from ship() — see the eviction comment there.
  private bufferDropped = 0

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

    // Evict oldest on overflow, mirroring the spool cap's drop-oldest policy.
    // The drop is counted here and reported from flush(), never logged inline:
    // error() routes back through the logger's write path into ship(), and an
    // overflowing buffer would recurse.
    if (this.buffer.length > MAX_BUFFER_RECORDS) {
      const excess = this.buffer.length - MAX_BUFFER_RECORDS
      this.buffer.splice(0, excess)
      this.bufferDropped += excess
    }

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
    this.reportBufferDrops()

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

  /** TEST ONLY. Current live-buffer depth. */
  _bufferLengthForTest(): number {
    return this.buffer.length
  }

  /**
   * Log and clear the pending buffer-overflow count. Called from flush() —
   * never from ship(), which would recurse through the logger's write path.
   */
  private reportBufferDrops(): void {
    if (this.bufferDropped === 0) return
    const dropped = this.bufferDropped
    this.bufferDropped = 0
    error('egress buffer overflow: oldest records dropped', {
      dropped,
      cap_records: MAX_BUFFER_RECORDS,
    })
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
