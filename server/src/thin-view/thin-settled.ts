/**
 * thin-settled -- settled conversations are sent on their own hash gate.
 *
 * `buildSnapshotEvent` carries `settledTabs` (the projection of
 * `tabs.json`'s `settledHistory`) inside the snapshot. That array is closed
 * conversations only: it grows monotonically over an install's life and
 * changes only when a conversation settles or is restored, which is rare
 * next to the per-tab churn that moves the snapshot hash.
 *
 * Because the snapshot hash covers the whole event, every active-tab change
 * re-sent the whole settled array with it. Measured on a real install: a
 * 498 KB snapshot of which 425 KB (455 records, ~935 bytes each) was settled
 * history, re-sent 515 times in one hour -- a quarter of a gigabyte over a
 * phone's relay connection to deliver a few changed tab rows.
 *
 * So the thin view splits them: the snapshot is hashed and sent without
 * `settledTabs`, and the settled array is hashed and sent separately as
 * `desktop_settled_tabs`. A client applies the two independently, which is
 * what it already did with one combined payload.
 */
import { createHash } from 'crypto'
import type { Connection } from '../protocol/connection'
import { sendThinEventTo } from './remote-out'
import { log as _log, debug as _debug } from '../logger'
import { withSpan } from '../tracing/op-span'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('thin-view', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}

/** Last settled-array hash sent per connection id. Swept when a connection closes. */
const lastSettledHashByConnection = new Map<string, string>()

export interface SplitSnapshot {
  /** The snapshot event with `settledTabs` removed -- what the snapshot hash is taken over. */
  snapshot: Record<string, unknown>
  /** The settled conversations that rode it, hashed and sent on their own gate. */
  settled: unknown[]
}

/**
 * Separate `settledTabs` from a built snapshot event. The input is never
 * mutated: the poller builds one event per principal and hands the same
 * object to every connection of that principal.
 */
export function splitSettledTabs(event: Record<string, unknown>): SplitSnapshot {
  const { settledTabs, ...snapshot } = event
  return { snapshot, settled: Array.isArray(settledTabs) ? settledTabs : [] }
}

export function hashSettled(settled: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(settled)).digest('hex')
}

/**
 * Send `settled` to one thin connection when its hash differs from what that
 * connection last received. Returns true when a frame was written.
 */
export function sendSettledIfChanged(conn: Connection, settled: unknown[], hash: string): boolean {
  if (lastSettledHashByConnection.get(conn.id) === hash) {
    debug('settled conversations unchanged for connection', { connection_id: conn.id, settled_count: settled.length })
    return false
  }
  const sent = withSpan('settled.publish', { attrs: { connection_id: conn.id, settled_count: settled.length } }, () =>
    sendThinEventTo(conn, { type: 'desktop_settled_tabs', settledTabs: settled }))
  if (!sent) return false
  lastSettledHashByConnection.set(conn.id, hash)
  log('settled conversations sent', { connection_id: conn.id, settled_count: settled.length, hash: hash.slice(0, 12) })
  return true
}

/** Forget one connection's settled hash. Called when it closes. */
export function forgetSettledHash(connectionId: string): void {
  lastSettledHashByConnection.delete(connectionId)
}

/** Drop the hash of every connection no longer in `liveIds`. */
export function sweepSettledHashes(liveIds: ReadonlySet<string>): void {
  for (const id of lastSettledHashByConnection.keys()) {
    if (!liveIds.has(id)) lastSettledHashByConnection.delete(id)
  }
}

export function _resetSettledHashesForTest(): void {
  lastSettledHashByConnection.clear()
}
