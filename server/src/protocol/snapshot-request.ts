/**
 * `studio_snapshot_request` -> `studio_snapshot` (manifest contract C3).
 *
 * A client that has been connected for a while and then rebinds its mirror
 * to this environment -- the desktop switching which environment its Studio
 * window shows -- hydrates from the last welcome/snapshot it retained, then
 * asks for a fresh one so the mirror converges on current state. The answer
 * is the SAME full first-paint payload `studio_welcome` carries, built for
 * this connection's principal so tenancy filtering applies exactly as it
 * did at hello time.
 */
import type { StudioSnapshot, StudioPrincipalSummary, StudioView } from '@ion/shared/studio-wire/types'
import type { Connection } from './connection'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-snapshot-request', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-snapshot-request', msg, fields)
}

export type SnapshotBuilder = (principal: StudioPrincipalSummary, view: StudioView) => StudioSnapshot

/** Answers one snapshot request on `conn`. Returns true when a frame was sent. */
export function handleSnapshotRequest(conn: Connection, buildSnapshot: SnapshotBuilder): boolean {
  if (!conn.principal) {
    warn('snapshot request before hello; dropping', { connection_id: conn.id })
    return false
  }
  let snapshot: StudioSnapshot
  try {
    snapshot = buildSnapshot(conn.principal, conn.view)
  } catch (err) {
    warn('snapshot build failed; request unanswered', { connection_id: conn.id, subject: conn.principal.subject, error: String(err) })
    return false
  }
  const sent = conn.send({ type: 'studio_snapshot', snapshot })
  log('snapshot request answered', { connection_id: conn.id, subject: conn.principal.subject, tab_count: snapshot.tabs.length, view: conn.view, sent })
  return sent
}
