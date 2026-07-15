/**
 * log-egress-spool.ts — disk-backed spool for undeliverable egress batches.
 *
 * When an egress flush fails (sink unreachable or non-2xx), the batch is
 * appended to ~/.ion/.egress-spool.jsonl rather than being dropped. On the
 * next flush tick the spool is drained first (FIFO) before the live buffer.
 *
 * Cap and backoff:
 *   - spoolMaxBytes (default 50 MB, config egressSpoolMaxBytes): when the spool
 *     exceeds this cap, the oldest lines are trimmed and an ERROR is logged.
 *   - Exponential backoff (base 5 s, cap 5 min): a dead sink does not hot-loop.
 *
 * At-least-once contract: duplicates are possible when a crash occurs between
 * a successful ship and the cursor/spool update. Telemetry lines carry event_id
 * (R22) so downstream dedup is available; operational log lines tolerate duplicates.
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, error as _error } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress_spool', msg, fields)
}
function err(msg: string, fields?: Record<string, unknown>): void {
  _error('log_egress_spool', msg, fields)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SPOOL_MAX_BYTES = 50 * 1024 * 1024 // 50 MB
export const SPOOL_PATH = join(homedir(), '.ion', '.egress-spool.jsonl')

const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 5 * 60 * 1_000

// ---------------------------------------------------------------------------
// Spool state
// ---------------------------------------------------------------------------

let _backoffUntil = 0
let _backoffDelayMs = 0

/** Returns true when the spool backoff window is active. */
export function isInBackoff(): boolean {
  return Date.now() < _backoffUntil
}

/** Advance the backoff delay (doubles each call, capped at BACKOFF_CAP_MS). */
export function advanceBackoff(): void {
  if (_backoffDelayMs === 0) {
    _backoffDelayMs = BACKOFF_BASE_MS
  } else {
    _backoffDelayMs = Math.min(_backoffDelayMs * 2, BACKOFF_CAP_MS)
  }
  _backoffUntil = Date.now() + _backoffDelayMs
}

/** Reset backoff on success. */
export function resetBackoff(): void {
  _backoffDelayMs = 0
  _backoffUntil = 0
}

/** TEST ONLY. Reset spool backoff state. */
export function _resetSpoolStateForTest(): void {
  _backoffDelayMs = 0
  _backoffUntil = 0
}

// ---------------------------------------------------------------------------
// Spool I/O
// ---------------------------------------------------------------------------

/**
 * Append records to the spool file as NDJSON. Trims oldest lines if the file
 * would exceed maxBytes after the append.
 */
export function appendToSpool(lines: string[], maxBytes: number = DEFAULT_SPOOL_MAX_BYTES): void {
  if (lines.length === 0) return
  const batch = lines.join('\n') + '\n'
  try {
    appendFileSync(SPOOL_PATH, batch, 'utf-8')
  } catch (e) {
    err('spool append failed', { error: e instanceof Error ? e.message : String(e) })
    return
  }
  trimSpoolToCap(maxBytes)
}

/**
 * Read all records from the spool. Returns an empty array if the spool is
 * absent or empty.
 */
export function readSpool(): string[] {
  if (!existsSync(SPOOL_PATH)) return []
  try {
    const content = readFileSync(SPOOL_PATH, 'utf-8')
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/**
 * Overwrite the spool with `lines` — the un-shipped remainder after a bounded,
 * partial drain. Deletes the spool when `lines` is empty.
 *
 * This is the progress-persistence primitive that makes incremental draining
 * safe: after a batch fails mid-drain, the forwarder writes back only the
 * records that have NOT shipped, so the next tick (or a restart) resumes from
 * the exact undelivered boundary. Without it, a partial drain would either
 * re-ship already-delivered records (append-only spool) or lose the remainder
 * (clear-on-any-progress) — the failure class that let one oversized,
 * never-deliverable request wedge the whole drain.
 */
export function rewriteSpoolRemainder(lines: string[]): void {
  if (lines.length === 0) {
    clearSpool()
    return
  }
  try {
    writeFileSync(SPOOL_PATH, lines.join('\n') + '\n', 'utf-8')
  } catch (e) {
    err('spool remainder rewrite failed', {
      error: e instanceof Error ? e.message : String(e),
      remainder_lines: lines.length,
    })
  }
}

/**
 * Delete the spool file. Called after a successful drain.
 */
export function clearSpool(): void {
  try {
    if (existsSync(SPOOL_PATH)) {
      unlinkSync(SPOOL_PATH)
      log('spool cleared')
    }
  } catch (e) {
    err('spool clear failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Return true when the spool has content to drain.
 */
export function hasSpoolContent(): boolean {
  if (!existsSync(SPOOL_PATH)) return false
  try {
    return statSync(SPOOL_PATH).size > 0
  } catch {
    return false
  }
}

/**
 * Trim the spool to maxBytes by removing lines from the front (oldest-first).
 * Logs ERROR when trimming occurs.
 */
export function trimSpoolToCap(maxBytes: number): void {
  if (!existsSync(SPOOL_PATH)) return
  let size: number
  try {
    size = statSync(SPOOL_PATH).size
  } catch {
    return
  }
  if (size <= maxBytes) return

  let content: string
  try {
    content = readFileSync(SPOOL_PATH, 'utf-8')
  } catch {
    return
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0)
  let dropped = 0
  let newContent = lines.join('\n') + '\n'
  while (Buffer.byteLength(newContent, 'utf-8') > maxBytes && lines.length > 0) {
    lines.shift()
    dropped++
    newContent = lines.join('\n') + '\n'
  }
  if (dropped > 0) {
    err('spool cap exceeded: oldest records dropped', {
      dropped,
      cap_bytes: maxBytes,
    })
    try {
      writeFileSync(SPOOL_PATH, newContent, 'utf-8')
    } catch (e) {
      err('spool trim write failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
