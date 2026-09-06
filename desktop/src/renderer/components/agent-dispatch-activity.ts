import type { Message } from '../../shared/types'

/**
 * Pure fold + reconcile logic for the live dispatched-agent transcript.
 *
 * The agent popup shows a running sub-agent's transcript built from two
 * sources that must converge without double-rendering (architecture C —
 * push + slow full-snapshot reconcile):
 *
 *  - PUSH: `dispatch_activity` deltas (tool_start / tool_end / stream_reset /
 *    text) arrive in
 *    real time. `foldActivity` folds each delta into an ordered entry list,
 *    deduping tool entries by `toolId` (updated in place across start→end) and
 *    streaming text by `dispatchSeq` (a coalesced run shares one seq slot).
 *
 *  - RECONCILE: the file-backed conversation transcript (loaded via
 *    getConversation) is the snapshot authority. `reconcileActivity` REPLACES
 *    the entry list with the snapshot, then re-applies any in-flight push
 *    entries the snapshot does not yet cover, so a dropped delta (reconnect,
 *    transport switch) self-heals on the next reconcile while a not-yet-
 *    persisted partial is not lost.
 *
 * Identity for convergence:
 *  - Tool entries: keyed by `toolId`. The same `toolId` is on the push
 *    tool_start/tool_end AND on the persisted tool message, so a tool present
 *    in both push and snapshot collapses to one entry.
 *  - Text entries: keyed by `seq` (push) — these have no persisted id until the
 *    assistant block finalizes, at which point the snapshot carries the real
 *    message and the seq-keyed partial is superseded.
 */

/** An ordered transcript entry derived from push deltas. */
export interface DispatchActivityEntry {
  /** Stable key: `tool:<toolId>` for tools, `seq:<n>` for text runs. */
  key: string
  /** Monotonic per-dispatch sequence; within-millisecond tiebreaker and text-run dedupe key. */
  seq: number
  /** Engine-authored unix millis timestamp (`dispatchActivityTs`). Primary sort key; 0 when absent. */
  ts: number
  message: Message
}

/** Per-dispatch push state: ordered entries keyed for dedupe. */
export interface DispatchActivityState {
  /** Insertion-ordered entry keys. */
  order: string[]
  /** key → entry. */
  entries: Record<string, DispatchActivityEntry>
}

/** A `dispatch_activity` normalized event payload (the fields the fold reads). */
export interface DispatchActivityDelta {
  dispatchConversationId: string
  dispatchActivityKind: 'text' | 'tool_start' | 'tool_end' | 'stream_reset'
  dispatchSeq: number
  /** Last committed sequence retained by a stream_reset rollback. */
  dispatchResetAfterSeq?: number
  toolName?: string
  toolId?: string
  dispatchTextDelta?: string
  dispatchToolIsError?: boolean
  dispatchActivityTs?: number
}

export function emptyActivityState(): DispatchActivityState {
  return { order: [], entries: {} }
}

/** Result of a fold: the next state plus a log-friendly branch tag. */
export interface FoldResult {
  state: DispatchActivityState
  /** "tool-added" | "tool-updated" | "text-added" | "text-updated" — for logging. */
  branch: string
}

/**
 * Fold one push delta into the per-dispatch state. Returns a new state
 * (immutable update) and the branch taken (for the caller's dedupe logging —
 * "both sides of the conditional" per the logging policy).
 */
export function foldActivity(prev: DispatchActivityState, delta: DispatchActivityDelta): FoldResult {
  if (delta.dispatchActivityKind === 'stream_reset') {
    const entries = Object.fromEntries(
      Object.entries(prev.entries).filter(([, entry]) => entry.seq <= (delta.dispatchResetAfterSeq ?? 0)),
    )
    const order = prev.order.filter((key) => entries[key] !== undefined)
    return { state: { order, entries }, branch: 'stream-reset' }
  }

  const order = [...prev.order]
  const entries = { ...prev.entries }

  if (delta.dispatchActivityKind === 'tool_start' || delta.dispatchActivityKind === 'tool_end') {
    const toolId = delta.toolId || `seq-${delta.dispatchSeq}`
    const key = `tool:${toolId}`
    const existing = entries[key]
    if (existing) {
      // tool_end (or a repeat) updates the existing tool entry in place.
      const message: Message = {
        ...existing.message,
        toolStatus: delta.dispatchActivityKind === 'tool_end'
          ? (delta.dispatchToolIsError ? 'error' : 'completed')
          : 'running',
      }
      entries[key] = { ...existing, message }
      return { state: { order, entries }, branch: 'tool-updated' }
    }
    // tool_start: new tool entry.
    const message: Message = {
      id: toolId,
      role: 'tool',
      content: '',
      toolName: delta.toolName || '',
      toolId,
      toolStatus: delta.dispatchActivityKind === 'tool_end'
        ? (delta.dispatchToolIsError ? 'error' : 'completed')
        : 'running',
      timestamp: delta.dispatchActivityTs || 0,
    }
    entries[key] = { key, seq: delta.dispatchSeq, ts: delta.dispatchActivityTs ?? 0, message }
    order.push(key)
    return { state: { order, entries }, branch: 'tool-added' }
  }

  // text: keyed by seq so a coalesced run that re-emits at the same seq updates
  // in place rather than appending a duplicate paragraph.
  const key = `seq:${delta.dispatchSeq}`
  const existing = entries[key]
  if (existing) {
    const message: Message = { ...existing.message, content: delta.dispatchTextDelta || '' }
    entries[key] = { ...existing, message }
    return { state: { order, entries }, branch: 'text-updated' }
  }
  const message: Message = {
    id: `dispatch-text-${delta.dispatchSeq}`,
    role: 'assistant',
    content: delta.dispatchTextDelta || '',
    timestamp: delta.dispatchActivityTs || 0,
  }
  entries[key] = { key, seq: delta.dispatchSeq, ts: delta.dispatchActivityTs ?? 0, message }
  order.push(key)
  return { state: { order, entries }, branch: 'text-added' }
}

/** Materialize the push state into an ordered Message[] (ts primary, seq tiebreaker). */
export function activityMessages(state: DispatchActivityState): Message[] {
  return state.order
    .map((k) => state.entries[k])
    .filter((e): e is DispatchActivityEntry => !!e)
    .sort((a, b) => {
      const tsDiff = a.ts - b.ts
      return tsDiff !== 0 ? tsDiff : a.seq - b.seq
    })
    .map((e) => e.message)
}

/**
 * Reconcile the file-backed snapshot with in-flight push entries. The snapshot
 * REPLACES the transcript (it is authoritative and heals any gap); push entries
 * are re-applied only when the snapshot does not already cover them, so:
 *   - a tool present in the snapshot (by toolId) wins — its push entry is dropped
 *     (no duplicate);
 *   - the push text run, once the snapshot has caught up, is dropped wholesale
 *     (the snapshot's persisted assistant message supersedes the fragments);
 *   - a push run newer than anything in the snapshot (the live in-flight
 *     partial) is preserved so the popup does not flicker backwards.
 *
 * Text identity is TURN-LEVEL COVERAGE, not exact equality and not per-fragment
 * matching. The engine (dispatch_activity.go) emits each coalesced text flush at
 * a NEW seq carrying only the INCREMENTAL text accumulated since the previous
 * flush — one push assistant entry per flush. Those fragments concatenate, in
 * materialized order, to exactly the single finalized assistant message the
 * snapshot persists for the turn. So:
 *   - Concatenate the `content` of the push assistant entries (in materialized
 *     order) into one string `pushTextRun`.
 *   - The run is COVERED when some snapshot assistant message (non-empty content)
 *     has content that STARTS WITH `pushTextRun` (prefix) — which includes the
 *     equal case. Coverage drops ALL the run's text fragments at once.
 *   - If no snapshot assistant message covers the concatenation, the run is a
 *     genuinely newer in-flight partial the snapshot has not caught up to → KEEP
 *     all its text fragments (do not drop).
 *
 * This is NOT the forbidden cross-block prefix heuristic (which compares two
 * DISTINCT persisted blocks whose strings happen to share a prefix). Here we
 * compare the single in-flight run against the single persisted message it is
 * becoming — prefix-of-a-single-finalized-message is identity-based coverage.
 *
 * Edge cases:
 *   - empty `pushTextRun` (no text fragments) → nothing to drop.
 *   - a snapshot with no assistant messages → never covers → all push text is
 *     kept (live, not yet persisted).
 *
 * Tools are deduped independently by `toolId` (unchanged) even when interleaved
 * with text in the materialized push order; only assistant-role entries form
 * `pushTextRun`. Surviving entries keep their relative materialized order and the
 * returned shape stays `[...snapshot, ...survivingPush]`.
 */
export function reconcileActivity(snapshot: Message[], push: DispatchActivityState): Message[] {
  const snapshotToolIds = new Set(
    snapshot.filter((m) => m.toolId).map((m) => m.toolId as string),
  )
  const snapshotAssistantContents = snapshot
    .filter((m) => m.role === 'assistant' && m.content)
    .map((m) => m.content)

  // Materialize the push entries once (ts primary, seq tiebreaker) so we read
  // a stable order for both the text concatenation and the surviving filter.
  const pushMessages = activityMessages(push)

  // Concatenate ONLY the assistant-role push entries, in materialized order,
  // into the run that the snapshot's single finalized message is becoming.
  const pushTextRun = pushMessages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('')

  // The run is covered when some snapshot assistant message starts with the
  // whole concatenation (prefix, incl. equality). Empty run → never covered
  // (nothing to drop); a snapshot with no assistant messages → never covers.
  const textRunCovered =
    pushTextRun.length > 0 &&
    snapshotAssistantContents.some((content) => content.startsWith(pushTextRun))

  const survivingPush = pushMessages.filter((m) => {
    if (m.role === 'tool' && m.toolId) {
      // Drop if the snapshot already carries this tool by id.
      return !snapshotToolIds.has(m.toolId)
    }
    if (m.role === 'assistant') {
      // Drop ALL text fragments only when the snapshot covers the whole run;
      // otherwise keep them (genuinely newer in-flight partial).
      return !textRunCovered
    }
    return true
  })

  return [...snapshot, ...survivingPush]
}
