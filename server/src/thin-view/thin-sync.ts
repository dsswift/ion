/**
 * thin-sync -- a thin connection's first paint and its snapshot convergence.
 *
 * First paint is the same envelope a `desktop_*` device gets on
 * `desktop_sync` (`remote/handlers/tabs-sync.ts` `sendSync`): the full
 * snapshot, engine profiles, the projectable settings snapshot, the theme
 * manifest, and terminal buffers, each as one `studio:thin-event`. It is sent
 * right after the welcome and again on every `studio_snapshot_request`, with
 * the tab list scoped to the connection's principal.
 *
 * Convergence is the poll tick (`remote/snapshot-polling.ts`): each tick,
 * every thin connection whose last-sent snapshot hash differs from the
 * current one for its principal is sent a fresh snapshot. The hash ignores
 * the same volatile per-tab fields the `desktop_*` poll gate ignores
 * (`hashSnapshot`), so a run in progress does not reship the snapshot.
 *
 * Settled conversations are not part of that gate. They are split out of the
 * snapshot and sent on a hash of their own (`thin-settled.ts`), because they
 * are the largest part of the payload and the part that almost never moves.
 */
import { sendSync } from '../remote/handlers/tabs-sync'
import { buildSnapshotEvent, hashSnapshot } from '../remote/snapshot-polling'
import type { Connection } from '../protocol/connection'
import { fullPresenceSnapshot } from '../protocol/presence'
import { startGitWatcherBridge, stopGitWatcherBridge } from '../remote/git-watcher-bridge'
import { thinConnections, sendThinEventTo, syncRemoteAttention, remoteClientsPresent } from './remote-out'
import { requestClientLogs, startClientLogRequests } from './client-log-request'
import { sendThinHeartbeat, startThinHeartbeat } from './thin-heartbeat'
import { splitSettledTabs, hashSettled, sendSettledIfChanged, forgetSettledHash, sweepSettledHashes, _resetSettledHashesForTest } from './thin-settled'
import { forgetTranscriptSubscriber } from '../transcript/transcript-publisher'
import { forgetDispatchSubscriber } from '../transcript/dispatch-transcript-publisher'
import { annotateSpan, failSpan, withSpan } from '../tracing/op-span'
import { log as _log, debug as _debug, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('thin-view', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('thin-view', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('thin-view', msg, fields)
}

/** Last snapshot hash sent per connection id. Entries for closed connections are swept each tick. */
const lastSnapshotHashByConnection = new Map<string, string>()

/** The working directories of a snapshot's tabs: what this principal's git events are scoped to. */
function directoriesOf(snapshot: Record<string, unknown>): ReadonlySet<string> {
  const tabs = Array.isArray(snapshot.tabs) ? (snapshot.tabs as Array<{ workingDirectory?: unknown }>) : []
  return new Set(tabs.map((tab) => tab.workingDirectory).filter((dir): dir is string => typeof dir === 'string' && dir.length > 0))
}

/** Send the whole first-paint envelope to one thin connection. */
export async function sendThinFirstPaint(conn: Connection): Promise<void> {
  if (conn.view !== 'thin' || !conn.principal) {
    debug('first paint skipped: not an admitted thin connection', { connection_id: conn.id, view: conn.view })
    return
  }
  const subject = conn.principal.subject
  await withSpan('thin.first_paint', { attrs: { connection_id: conn.id, user: subject } }, () => sendFirstPaintNow(conn, subject))
}

async function sendFirstPaintNow(conn: Connection, subject: string): Promise<void> {
  let events = 0
  try {
    await sendSync((event: Record<string, unknown>) => {
      if (event.type !== 'desktop_snapshot') {
        if (sendThinEventTo(conn, event)) events++
        return
      }
      // Settled conversations leave the snapshot and ride their own hash
      // gate, so later active-tab churn never re-sends them (thin-settled.ts).
      const { snapshot, settled } = splitSettledTabs(event)
      lastSnapshotHashByConnection.set(conn.id, hashSnapshot(snapshot))
      conn.thinDirectories = directoriesOf(snapshot)
      if (sendThinEventTo(conn, snapshot)) events++
      if (sendSettledIfChanged(conn, settled, hashSettled(settled))) events++
    }, subject, conn.scopes)
    // Presence rides first paint, not only the next change: a client that
    // connects into a shared environment must see who else is here at once.
    const presence = fullPresenceSnapshot()
    if (sendThinEventTo(conn, { type: 'desktop_presence', entries: presence.entries, driving: presence.driving })) events++
    // A thin client depends on push-driven git freshness exactly as a
    // desktop_* device does; the poll tick reconciles the directory set.
    startGitWatcherBridge()
    syncRemoteAttention()
    // The client's own log is the only record of what it did; ask for what it
    // has written since the last cursor, now and on the pull interval.
    requestClientLogs(conn)
    startClientLogRequests()
    // Something to time, now rather than on the first beat: a client that
    // has just attached would otherwise read its own link as dead until the
    // interval comes round.
    sendThinHeartbeat(conn)
    startThinHeartbeat()
    annotateSpan({ event_count: events })
    log('thin first paint sent', { connection_id: conn.id, subject, event_count: events })
  } catch (err) {
    failSpan(String(err))
    warn('thin first paint failed', { connection_id: conn.id, subject, error: String(err) })
  }
}

/** A thin connection closed: drop its remote attention, and the git bridge with the last client. */
export function noteThinConnectionClosed(conn: Connection): void {
  forgetTranscriptSubscriber(conn)
  forgetDispatchSubscriber(conn)
  lastSnapshotHashByConnection.delete(conn.id)
  forgetSettledHash(conn.id)
  syncRemoteAttention()
  const clientsRemain = remoteClientsPresent()
  if (!clientsRemain) stopGitWatcherBridge()
  log('thin connection closed', { connection_id: conn.id, clients_remain: clientsRemain })
}

/**
 * One poll tick's thin half: send a fresh snapshot to every thin connection
 * whose hash is stale. The snapshot is built once per distinct principal.
 */
export async function publishThinSnapshots(): Promise<void> {
  const conns = thinConnections().filter((conn) => conn.principal !== null)
  const live = new Set(conns.map((conn) => conn.id))
  for (const id of lastSnapshotHashByConnection.keys()) {
    if (!live.has(id)) lastSnapshotHashByConnection.delete(id)
  }
  sweepSettledHashes(live)
  if (conns.length === 0) return

  const built = new Map<string, { event: Record<string, unknown>; hash: string; settled: unknown[]; settledHash: string }>()
  let sent = 0
  let settledSent = 0
  for (const conn of conns) {
    const subject = conn.principal!.subject
    let snapshot = built.get(subject)
    if (!snapshot) {
      const { event } = await buildSnapshotEvent(subject)
      const split = splitSettledTabs(event)
      snapshot = { event: split.snapshot, hash: hashSnapshot(split.snapshot), settled: split.settled, settledHash: hashSettled(split.settled) }
      built.set(subject, snapshot)
    }
    // The two gates are independent: a settled conversation that changed is
    // sent even when the active-tab snapshot did not move, and vice versa.
    // Order matches first paint -- the snapshot, then what was split out of it.
    if (lastSnapshotHashByConnection.get(conn.id) !== snapshot.hash) {
      conn.thinDirectories = directoriesOf(snapshot.event)
      lastSnapshotHashByConnection.set(conn.id, snapshot.hash)
      if (sendThinEventTo(conn, snapshot.event)) sent++
    }
    if (sendSettledIfChanged(conn, snapshot.settled, snapshot.settledHash)) settledSent++
  }
  if (sent > 0 || settledSent > 0) log('thin snapshots sent', { connection_count: sent, settled_count: settledSent, thin_connections: conns.length })
  else debug('thin snapshots unchanged for every connection', { thin_connections: conns.length })
}

export function _resetThinSyncForTest(): void {
  lastSnapshotHashByConnection.clear()
  _resetSettledHashesForTest()
}
