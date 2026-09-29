/**
 * plan-content-window -- one bounded window of a plan's text.
 *
 * A plan can be far larger than a frame a constrained client should take in
 * one piece, so it is read in windows addressed by BYTE offset. Two sources,
 * in order: the plan content the store already holds for a pending ExitPlanMode
 * (what the engine reported for the active instance, found by `questionId`),
 * then the plan file on disk through the mtime-keyed cache.
 *
 * A window never ends inside a UTF-8 character. A client assembles the plan by
 * appending each window's text and asks for the next one at
 * `offset + byteLength(text)`. Cut at a raw byte offset, a window that ends
 * mid-character decodes its tail to U+FFFD -- three bytes that were never in
 * the file -- so the assembled text is corrupted AND every later offset is
 * wrong. Ending on a character boundary makes `byteLength(text)` equal the
 * bytes actually consumed, which is what that arithmetic assumes.
 */
import { existsSync } from 'fs'
import { useSessionStore } from './store/sessionStore'
import { readPlanRangeCached } from './remote/plan-content-cache'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('plan-content-window', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('plan-content-window', msg, fields)
}

/** The largest window served, whatever was asked for. */
export const PLAN_WINDOW_MAX_BYTES = 64 * 1024

export interface PlanWindowRequest {
  planFilePath: string
  /** The pending ExitPlanMode this plan belongs to; enables the store-first lookup. */
  questionId?: string
  offset?: number
  /** Bytes wanted; clamped to `PLAN_WINDOW_MAX_BYTES`. Absent or non-positive means the maximum. */
  length?: number
}

export interface PlanWindow {
  content: string
  offset: number
  totalBytes: number
  hasMore: boolean
  /** Where the text came from; `none` when there is no such plan. */
  source: 'store' | 'disk' | 'none'
}

/**
 * The largest `end <= wanted` that does not split a UTF-8 character. A
 * continuation byte is `10xxxxxx`; backing off while the byte AT `end` is one
 * lands `end` on the first byte of a character (or the end of the buffer).
 */
export function utf8SafeEnd(buf: Buffer, wanted: number): number {
  let end = Math.min(Math.max(0, wanted), buf.length)
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end--
  return end
}

/** Cuts `[offset, offset+length)` from `buf`, ending on a character boundary. */
export function utf8Window(buf: Buffer, offset: number, length: number): { text: string; end: number } {
  const start = Math.max(0, Math.min(offset, buf.length))
  const end = Math.max(start, utf8SafeEnd(buf, start + Math.max(0, length)))
  return { text: buf.subarray(start, end).toString('utf-8'), end }
}

/** Plan content the store holds for a pending ExitPlanMode, or null. */
function planContentFromStore(questionId: string | undefined): string | null {
  const panes = useSessionStore.getState().conversationPanes
  for (const pane of panes.values()) {
    if (!pane?.instances) continue
    for (const inst of pane.instances) {
      for (const denied of inst.permissionDenied?.tools ?? []) {
        const input = denied.toolInput as { planContent?: string } | undefined
        if (denied.toolName === 'ExitPlanMode' && input?.planContent) return input.planContent
      }
      if (!questionId) continue
      const queue = (inst as unknown as { permissionQueue?: Array<{ questionId?: string; toolInput?: { planContent?: string } }> }).permissionQueue ?? []
      for (const q of queue) {
        if (q.questionId === questionId && q.toolInput?.planContent) return q.toolInput.planContent
      }
    }
  }
  return null
}

export function readPlanWindow(req: PlanWindowRequest): PlanWindow {
  const offset = Math.max(0, Math.floor(req.offset ?? 0))
  const length = req.length && req.length > 0 ? Math.min(Math.floor(req.length), PLAN_WINDOW_MAX_BYTES) : PLAN_WINDOW_MAX_BYTES
  const questionId = (req.questionId ?? '').slice(0, 12)

  let fromStore: string | null = null
  try {
    fromStore = planContentFromStore(req.questionId)
  } catch (err) {
    // The store is an optimisation over the disk read, not the authority.
    warn('store lookup failed; reading the plan file instead', { question_id: questionId, error: String(err) })
  }
  if (fromStore) {
    const buf = Buffer.from(fromStore, 'utf-8')
    const { text, end } = utf8Window(buf, offset, length)
    log('plan window served', { question_id: questionId, source: 'store', total_bytes: buf.length, offset, window_bytes: end - Math.min(offset, buf.length) })
    return { content: text, offset, totalBytes: buf.length, hasMore: end < buf.length, source: 'store' }
  }

  if (!req.planFilePath || !existsSync(req.planFilePath)) {
    log('plan window: no such plan', { question_id: questionId, path: req.planFilePath })
    return { content: '', offset, totalBytes: 0, hasMore: false, source: 'none' }
  }
  try {
    // The cache hands back the window it was asked for; re-cut it from the
    // same bytes so the end lands on a character boundary.
    const { window, totalBytes } = readPlanRangeCached(req.planFilePath, offset, length + 3)
    const { text, end } = utf8Window(window, 0, length)
    const consumed = Math.min(offset, totalBytes) + end
    log('plan window served', { question_id: questionId, source: 'disk', path: req.planFilePath, total_bytes: totalBytes, offset, window_bytes: end })
    return { content: text, offset, totalBytes, hasMore: consumed < totalBytes, source: 'disk' }
  } catch (err) {
    warn('plan file read failed', { question_id: questionId, path: req.planFilePath, error: (err as Error).message })
    return { content: '', offset, totalBytes: 0, hasMore: false, source: 'none' }
  }
}
