// Shared, pure builder for the "[Compaction]" checkpoint marker rendered in
// the conversation after a compaction completes. It is the single source of
// truth for the marker string so the renderer (event-slice.ts) and the
// iOS-bound bridge (event-wiring-remote.ts) never drift.
//
// This module is pure (no Electron/IPC binding) and therefore import-safe from
// both the renderer and the main process — see desktop AGENTS.md § IPC.

/** The completion-side fields of a `compacting` event (active === false). */
export interface CompactionMarkerEvent {
  summary?: string
  messagesBefore?: number
  messagesAfter?: number
  clearedBlocks?: number
  strategy?: string
  /**
   * True when the engine ran a micro-only compaction: blocks were cleared in
   * place but no messages were dropped (messagesBefore === messagesAfter). The
   * marker must NOT show an "N → N messages" figure in this case.
   */
  microOnly?: boolean
}

/** Prefix every marker system message carries. Parsers key on it. */
export const COMPACTION_MARKER_PREFIX = '[Compaction]'

/**
 * Builds the `[Compaction]` system-message content for a completed compaction,
 * or returns `null` when no marker should be shown.
 *
 * Rules:
 *  - Pure no-op (no cleared blocks, no dropped messages, no summary) → `null`.
 *    Nothing happened; show nothing.
 *  - Micro-only pass (`microOnly` true, or messages not dropped) → headline
 *    omits the misleading "N → N messages" segment and reads
 *    "[Compaction] · <strategy> · K blocks cleared". A micro-only pass never
 *    renders "N → N".
 *  - Real drop (`messagesAfter < messagesBefore`) → keeps the
 *    "N → M messages" headline plus optional "K blocks cleared" and summary.
 */
export function buildCompactionMarkerContent(event: CompactionMarkerEvent): string | null {
  const before = event.messagesBefore ?? 0
  const after = event.messagesAfter ?? 0
  const cleared = event.clearedBlocks ?? 0
  const droppedMessages = before > 0 && after < before
  const summary = event.summary?.trim() ? event.summary : ''

  // Pure no-op: nothing was cleared, nothing was dropped, no summary.
  if (!droppedMessages && cleared === 0 && !summary) {
    return null
  }

  // A pass is micro-only when the engine flagged it, or (defensively) when no
  // messages were dropped. In that case we never render "N → N messages".
  const microOnly = event.microOnly === true || !droppedMessages

  const parts = [COMPACTION_MARKER_PREFIX]
  if (event.strategy) parts.push(event.strategy)

  if (!microOnly) {
    parts.push(`${before} → ${after} messages`)
  }
  if (cleared) {
    parts.push(`${cleared} blocks cleared`)
  }

  let content = parts.join(' · ')
  if (summary) content += '\n\n' + summary
  return content
}

/**
 * Builds a short "nothing to compact" notice for a MANUAL (`strategy === 'user'`)
 * no-op compaction, or `null` when a notice should not be shown.
 *
 * Why this is separate from `buildCompactionMarkerContent`:
 *  - `buildCompactionMarkerContent` returns `null` for any no-op (nothing
 *    cleared, dropped, or summarized), which is correct for the persisted
 *    conversation marker: an auto-compaction that did nothing, and history
 *    reloads, must stay silent.
 *  - But when the USER explicitly runs `/compact` and it turns out there is
 *    nothing to do, silence is indistinguishable from a crash. This helper
 *    produces a live, display-only system line so the user gets explicit
 *    feedback. It is intentionally NOT part of `buildCompactionMarkerContent`,
 *    so it never lands in the persisted marker or fires for auto-compaction.
 *
 * A no-op is: no summary, no cleared blocks, and no dropped messages
 * (`messagesBefore === messagesAfter`). The `strategy === 'user'` gate is what
 * distinguishes an explicit user request (worth a notice) from a proactive
 * auto pass (stay silent).
 */
export function buildManualCompactionNoOpNotice(
  event: CompactionMarkerEvent & { strategy?: string },
): string | null {
  if (event.strategy !== 'user') return null

  const before = event.messagesBefore ?? 0
  const after = event.messagesAfter ?? 0
  const cleared = event.clearedBlocks ?? 0
  const droppedMessages = before > 0 && after < before
  const summary = event.summary?.trim() ? event.summary : ''

  // Only a true no-op earns the notice. If anything actually happened, the
  // real marker (buildCompactionMarkerContent) covers it and this returns null.
  if (droppedMessages || cleared !== 0 || summary) return null

  return `${COMPACTION_MARKER_PREFIX} · nothing to compact`
}
