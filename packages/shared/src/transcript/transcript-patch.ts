/**
 * transcript-patch — how a thin client keeps its copy of a transcript equal
 * to the server's.
 *
 * A client holds one TRANSCRIPT STREAM per conversation it has open: a
 * snapshot (a `studio_body` reply) followed by `desktop_transcript_patch`
 * events. Each patch names the revision it was computed against (`baseRev`)
 * and the revision it produces (`rev`). A client applies a patch only when its
 * own revision equals `baseRev` and the `epoch` matches; anything else means it
 * missed something, and it asks for a fresh snapshot. Nothing is inferred: a
 * missing revision is the proof, and the fix is always the same full reload.
 *
 * `epoch` changes whenever the server starts a stream over (a restart, or a
 * stream dropped and reopened), so revision numbers from two different runs
 * can never be mistaken for each other. For the same reason a client that
 * reconnects may name the `{epoch, rev}` it holds in its snapshot request:
 * if that is still the stream's revision, the two hold the same rows and
 * the server sends none.
 */
import { utf8Bytes, type TranscriptRow } from './transcript-row'

/** The row fields that grow by appending while a row streams. */
export type TranscriptAppendField = 'content' | 'toolInput'

/** One change between two published revisions. */
export type TranscriptChange =
  /** One row grew: `text` is appended to `field` of the row at `index`. */
  | { kind: 'append'; index: number; id: string; field: TranscriptAppendField; text: string }
  /** Replace `deleteCount` rows at `at` with `rows`. */
  | { kind: 'splice'; at: number; deleteCount: number; rows: TranscriptRow[] }
  /** The change is too large for one frame: request a fresh snapshot. */
  | { kind: 'reset'; reason: 'too_large' }

/**
 * Which transcript a stream carries. A conversation instance of a tab, or a
 * dispatched agent's conversation. `streamId` is the one key both sides store
 * it under; build it only with `transcriptStreamId`.
 */
export type TranscriptStreamKey =
  | { kind: 'tab'; tabId: string; instanceId: string }
  | { kind: 'dispatch'; tabId: string; conversationId: string; dispatchId: string }

export function transcriptStreamId(key: TranscriptStreamKey): string {
  return key.kind === 'tab' ? `tab:${key.tabId}:${key.instanceId}` : `dispatch:${key.conversationId}:${key.dispatchId}`
}

/** The thin event that carries one change. */
export interface TranscriptPatchEvent {
  type: 'desktop_transcript_patch'
  streamId: string
  /** The owning conversation. Dispatch streams name their parent tab. */
  tabId: string
  instanceId?: string
  /** Dispatch streams only: the dispatched conversation and dispatch. */
  conversationId?: string
  dispatchId?: string
  epoch: string
  baseRev: number
  rev: number
  /** Row count after this change. */
  total: number
  change: TranscriptChange
}

/** Stream fields a `studio_body` reply carries for a thin connection. */
export interface TranscriptSnapshotFields {
  streamId: string
  epoch: string
  rev: number
  /** Row count of the whole transcript at `rev`. */
  total: number
  /** Index in the whole transcript of `rows[0]`. */
  startIndex: number
}

/**
 * Largest serialized `splice` a patch may carry. Well under the connection's
 * send cap, so a patch never competes with the cap; a change larger than this
 * is a `reset` and the client pages the transcript in instead.
 */
export const TRANSCRIPT_PATCH_BYTE_BUDGET = 1024 * 1024

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Field-by-field equality of two projected rows. */
export function transcriptRowsEqual(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a === b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TranscriptRow>
  for (const key of keys) {
    if (!sameValue(a[key], b[key])) return false
  }
  return true
}

/** The field that grew by a pure append, when that is the ONLY difference. */
function appendedField(prev: TranscriptRow, next: TranscriptRow): { field: TranscriptAppendField; text: string } | null {
  if (prev.id !== next.id) return null
  let grown: { field: TranscriptAppendField; text: string } | null = null
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof TranscriptRow>
  for (const key of keys) {
    if (sameValue(prev[key], next[key])) continue
    if (key !== 'content' && key !== 'toolInput') return null
    if (grown) return null
    const before = prev[key] ?? ''
    const after = next[key] ?? ''
    if (after.length <= before.length || !after.startsWith(before)) return null
    grown = { field: key, text: after.slice(before.length) }
  }
  return grown
}

/**
 * The single change that turns `prev` into `next`, or null when they are equal.
 *
 * An `append` when exactly one row differs and it only grew one streamed
 * field; otherwise the minimal `splice` between the common prefix and the
 * common suffix; a `reset` when that splice is larger than `byteBudget`.
 */
export function diffTranscript(
  prev: readonly TranscriptRow[],
  next: readonly TranscriptRow[],
  byteBudget: number = TRANSCRIPT_PATCH_BYTE_BUDGET,
): TranscriptChange | null {
  const shorter = Math.min(prev.length, next.length)
  let prefix = 0
  while (prefix < shorter && transcriptRowsEqual(prev[prefix], next[prefix])) prefix++
  if (prefix === prev.length && prefix === next.length) return null
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    transcriptRowsEqual(prev[prev.length - 1 - suffix], next[next.length - 1 - suffix])
  ) suffix++

  const deleteCount = prev.length - prefix - suffix
  const rows = next.slice(prefix, next.length - suffix)
  if (deleteCount === 1 && rows.length === 1) {
    const grown = appendedField(prev[prefix], rows[0])
    if (grown) return { kind: 'append', index: prefix, id: rows[0].id, field: grown.field, text: grown.text }
  }
  if (utf8Bytes(JSON.stringify(rows)) > byteBudget) return { kind: 'reset', reason: 'too_large' }
  return { kind: 'splice', at: prefix, deleteCount, rows }
}

/**
 * Applies one change to a row list. Returns null when the change does not fit
 * the list it was computed against — a client that sees null has diverged and
 * must take a fresh snapshot. A `reset` also returns null.
 */
export function applyTranscriptChange(rows: readonly TranscriptRow[], change: TranscriptChange): TranscriptRow[] | null {
  if (change.kind === 'reset') return null
  if (change.kind === 'append') {
    const row = rows[change.index]
    if (!row || row.id !== change.id) return null
    const out = rows.slice()
    out[change.index] = { ...row, [change.field]: (row[change.field] ?? '') + change.text }
    return out
  }
  if (change.at < 0 || change.at + change.deleteCount > rows.length) return null
  const out = rows.slice()
  out.splice(change.at, change.deleteCount, ...change.rows)
  return out
}
