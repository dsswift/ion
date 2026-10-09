/**
 * transcript-channel — the part every transcript stream shares: turning a new
 * set of projected rows into one revisioned patch and sending it to the
 * stream's subscribers.
 *
 * A tab's transcript (transcript-publisher.ts) and a dispatched agent's
 * transcript (dispatch-transcript-publisher.ts) differ only in where their
 * rows come from. Publishing is the same, so it lives here once.
 */
import { diffTranscript, type TranscriptPatchEvent } from '@ion/shared/transcript/transcript-patch'
import type { TranscriptRow } from '@ion/shared/transcript/transcript-row'
import { sendThinEventTo } from '../thin-view/remote-out'
import { shouldStreamThinkingToRemote } from '../persistence/settings-store'
import type { Connection } from '../protocol/connection'
import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('transcript', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('transcript', msg, fields)
}

/**
 * Rows as a thin client may receive them. With `streamThinkingToRemote` off
 * (the phone's low-bandwidth setting), a thinking row keeps its place and its
 * summary (how long, how many tokens) but not its text.
 */
export function rowsForThinClients(rows: TranscriptRow[]): TranscriptRow[] {
  if (shouldStreamThinkingToRemote()) return rows
  return rows.map((row) => (row.role === 'thinking' && row.content !== '' ? { ...row, content: '' } : row))
}

/**
 * How long a stream is kept after its last subscriber leaves. A client whose
 * connection dropped comes back holding the revision it last saw; while the
 * stream is kept at that revision, the client resumes it instead of being
 * sent every row again.
 */
export const TRANSCRIPT_LINGER_MS = 30 * 60_000

/** The revision of a stream a client says it holds. */
export interface HeldRevision {
  epoch: string
  rev: number
}

/** What a published stream holds: its identity, revision, rows, and audience. */
export interface TranscriptChannelCore {
  streamId: string
  epoch: string
  rev: number
  rows: TranscriptRow[]
  subscribers: Set<Connection>
  /** Set while the stream is kept with no subscribers: the timer that closes it. */
  linger: ReturnType<typeof setTimeout> | null
}

/** Whether `held` is exactly the revision the channel last published. */
export function holdsCurrent(channel: TranscriptChannelCore, held: HeldRevision | undefined): boolean {
  return held !== undefined && held.epoch === channel.epoch && held.rev === channel.rev
}

/**
 * Keep a channel whose last subscriber left, and close it with `close` if
 * nobody resumes it in time. The owner publishes nothing while it is kept, so
 * it stays at the revision its last subscriber saw.
 */
export function startLinger(channel: TranscriptChannelCore, close: () => void): void {
  if (channel.linger) return
  channel.linger = setTimeout(close, TRANSCRIPT_LINGER_MS)
  channel.linger.unref()
  log('transcript channel kept for resume', { stream_id: channel.streamId, rev: channel.rev, linger_ms: TRANSCRIPT_LINGER_MS })
}

export function endLinger(channel: TranscriptChannelCore): void {
  if (!channel.linger) return
  clearTimeout(channel.linger)
  channel.linger = null
}

/** The fields of a patch that name its stream's owner. */
export type TranscriptPatchOwner = Pick<TranscriptPatchEvent, 'tabId' | 'instanceId' | 'conversationId' | 'dispatchId'>

/**
 * Publish `next` as the channel's new rows. Sends nothing when they equal
 * the rows last published. A subscriber whose connection refuses the send is
 * dropped. Returns true when the channel still has subscribers.
 */
export function publishTranscriptRows(channel: TranscriptChannelCore, next: TranscriptRow[], owner: TranscriptPatchOwner): boolean {
  const change = diffTranscript(channel.rows, next)
  if (!change) return channel.subscribers.size > 0
  const baseRev = channel.rev
  channel.rev += 1
  channel.rows = next
  const patch: TranscriptPatchEvent = {
    type: 'desktop_transcript_patch',
    streamId: channel.streamId,
    ...owner,
    epoch: channel.epoch,
    baseRev,
    rev: channel.rev,
    total: next.length,
    change,
  }
  if (change.kind === 'reset') {
    log('transcript patch is a reset; subscribers will take a snapshot', {
      stream_id: channel.streamId, rev: channel.rev, total: next.length,
    })
  } else {
    debug('transcript patch', {
      stream_id: channel.streamId, kind: change.kind, rev: channel.rev, total: next.length,
      rows: change.kind === 'splice' ? change.rows.length : 1,
    })
  }
  for (const conn of [...channel.subscribers]) {
    if (!sendThinEventTo(conn, patch as unknown as Record<string, unknown>)) {
      channel.subscribers.delete(conn)
      log('transcript subscriber dropped: send refused', { stream_id: channel.streamId, connection_id: conn.id })
    }
  }
  return channel.subscribers.size > 0
}
