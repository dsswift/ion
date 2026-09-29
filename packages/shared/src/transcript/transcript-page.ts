/**
 * transcript-page — cutting one page out of a projected transcript.
 *
 * A snapshot for a long conversation is sent newest page first; older pages
 * are fetched as the reader scrolls. A page ends at the cursor (a row id) and
 * reaches back to the start of a user turn, so a turn is never split, and it
 * is bounded both by row count and by bytes: row count alone let a
 * transcript of heavy rows overflow the connection's send cap.
 */
import { utf8Bytes, type TranscriptRow } from './transcript-row'

/** Smallest page a client can ask for. */
export const TRANSCRIPT_MIN_PAGE_ROWS = 10
/** Largest page a client can ask for. */
export const TRANSCRIPT_MAX_PAGE_ROWS = 2000
/**
 * Byte ceiling of one page's rows. Half the connection's 8 MiB send cap,
 * leaving room for the frame envelope and anything queued behind it.
 */
export const TRANSCRIPT_PAGE_BYTE_BUDGET = 4 * 1024 * 1024

export interface TranscriptPage {
  rows: TranscriptRow[]
  /** Index of `rows[0]` in the whole transcript. */
  startIndex: number
  total: number
  hasOlder: boolean
  /** The id to send as `before` for the next older page. */
  cursor?: string
}

export function clampTranscriptPageRows(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return TRANSCRIPT_MAX_PAGE_ROWS
  return Math.min(Math.max(Math.floor(requested), TRANSCRIPT_MIN_PAGE_ROWS), TRANSCRIPT_MAX_PAGE_ROWS)
}

/**
 * The page ending just before `before` (or at the newest row), at most
 * `limit` rows and `byteBudget` bytes, starting at a user turn. A single row
 * larger than the budget is still sent on its own: a page must always make
 * progress.
 */
export function pageTranscript(
  all: readonly TranscriptRow[],
  before: string | undefined,
  limit: number,
  byteBudget: number = TRANSCRIPT_PAGE_BYTE_BUDGET,
): TranscriptPage {
  const total = all.length
  let end = total
  if (before !== undefined) {
    const at = all.findIndex((row) => row.id === before)
    // An unknown cursor names a row this transcript no longer has; the
    // honest answer is the newest page, which the client treats as a restart.
    if (at >= 0) end = at
  }

  let start = end
  let bytes = 0
  while (start > 0 && end - start < limit) {
    const size = utf8Bytes(JSON.stringify(all[start - 1]))
    if (start < end && bytes + size > byteBudget) break
    bytes += size
    start--
  }
  // Drop a partial turn off the front so a page starts at a user row. The
  // dropped rows belong to the next older page, which ends at this page's
  // first row. A single turn larger than the whole page is kept as it is:
  // trimming it would leave nothing to send.
  let aligned = start
  while (aligned < end && all[aligned].role !== 'user') aligned++
  if (start > 0 && aligned < end) start = aligned

  const rows = all.slice(start, end)
  const hasOlder = start > 0
  return { rows, startIndex: start, total, hasOlder, ...(hasOlder && rows.length > 0 ? { cursor: rows[0].id } : {}) }
}
