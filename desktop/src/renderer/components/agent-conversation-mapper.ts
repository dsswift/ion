/**
 * Stable per-message ID mapping for dispatched-agent conversation history.
 *
 * The engine's `get_conversation` response (SessionMessage[]) carries a
 * `toolId` field on tool rows (the Anthropic tool-use ID, e.g. `toolu_01…`)
 * but has no top-level ID field on user/assistant rows. This module derives
 * stable, deterministic IDs so React's reconciler can preserve DOM nodes
 * across refetches rather than tearing them down and recreating them — which
 * previously reset the scroll position on every 12-second slow-reconcile poll.
 *
 * ID strategy:
 *  - Tool messages: `tool-${m.toolId}` — the Anthropic tool-use ID is
 *    persisted in the JSONL entry and never changes across refetches.
 *  - User / assistant messages: `${m.role}-${m.timestamp}`. The engine stores
 *    the entry timestamp on disk (int64 ms), so it is stable across refetches.
 *    Collision suffix `#n` (n >= 1) is appended when the same (role, timestamp)
 *    pair appears more than once in the same response (e.g. two assistant turns
 *    in the same millisecond).
 *
 * The helper is a pure function so it can be unit-tested without any React or
 * IPC infrastructure.
 */

import type { Message } from '../../shared/types'

/** Shape of a raw message returned by window.ion.getConversation. */
export interface RawSessionMessage {
  role: string
  content: string
  toolName?: string
  toolId?: string
  toolInput?: string
  timestamp?: number
  /**
   * Plan-lifecycle marker rows (plan-created / plan-updated / plan-implemented
   * dividers) carry the canonical plan file path so SystemMessage can render a
   * clickable slug. Present only on `role: 'system'` divider rows; empty on
   * ordinary conversation rows. Mirrors `Message.planFilePath` and the shape
   * event-slice-plan-mode.ts / serialize-conversation-pane.ts persist.
   */
  planFilePath?: string
  /** Harness dedup key (see serialize-conversation-pane.ts). Harness rows only. */
  dedupKey?: string
  /** Slash-command provenance forwarded from the engine SessionMessage. */
  slashCommand?: string
  slashArgs?: string
  slashSource?: string
  /** Intercept level on `role: 'harness'` banner/redirect rows. */
  interceptLevel?: string
}

/**
 * Map raw engine SessionMessage[] into typed Message[] with stable IDs.
 *
 * Called by AgentPanel.refetchConversation after every getConversation fetch.
 * Deterministic: calling with the same input always produces the same IDs.
 *
 * Marker rows (steer / plan-lifecycle dividers, compaction boundaries) arrive
 * as `role: 'system'` rows whose content carries the sentinel prefix
 * groupMessages keys on (`── Steer applied`, `── Plan created`, `── Plan
 * updated`, `── Implementing plan`, `[Compaction]`). This mapper forwards those
 * rows verbatim — preserving role, content, and the marker-only fields
 * (planFilePath, dedupKey, slash provenance, interceptLevel) — so the dispatch
 * preview renders the SAME markers the main transcript does through the shared
 * groupMessages / TranscriptRows path (AgentDetailPanel). Tool-only fields
 * (toolName / toolId / toolInput / toolStatus) are stamped ONLY on tool rows;
 * stamping toolStatus on a system marker row is incorrect and was a prior bug.
 */
export function mapConversationMessages(rawMessages: RawSessionMessage[]): Message[] {
  // Track how many times each (role, timestamp) base key has been seen so far
  // in this response, to generate collision-avoidance suffixes.
  const seenCounts = new Map<string, number>()

  return rawMessages.map((m) => {
    let id: string
    const isToolRow = !!m.toolId

    if (isToolRow) {
      // Tool rows: use the persisted Anthropic tool-use ID directly.
      id = `tool-${m.toolId}`
    } else {
      // User / assistant / system / harness rows: base key is role + timestamp.
      const ts = m.timestamp ?? 0
      const base = `${m.role}-${ts}`
      const count = seenCounts.get(base) ?? 0
      seenCounts.set(base, count + 1)
      // First occurrence uses the plain base key; subsequent occurrences append
      // a 1-based suffix so every ID in the array is unique.
      id = count === 0 ? base : `${base}#${count}`
    }

    const out: Message = {
      id,
      role: m.role as Message['role'],
      content: m.content,
      timestamp: m.timestamp ?? 0,
    }

    // Tool-only fields — stamp exclusively on tool rows so system/harness/plan
    // marker rows are not mislabelled with a tool status (which would corrupt
    // their classification and rendering).
    if (isToolRow) {
      out.toolName = m.toolName || ''
      out.toolId = m.toolId || ''
      out.toolInput = m.toolInput || ''
      out.toolStatus = 'completed'
    }

    // Marker / provenance fields — forward only when present so ordinary rows
    // stay lean. planFilePath makes the plan slug clickable in SystemMessage;
    // the slash + intercept + dedup fields let groupMessages classify harness
    // and command-pill rows exactly as the main transcript does.
    if (m.planFilePath) out.planFilePath = m.planFilePath
    if (m.dedupKey) out.dedupKey = m.dedupKey
    if (m.interceptLevel) out.interceptLevel = m.interceptLevel
    if (m.slashCommand) {
      out.slashCommand = m.slashCommand
      out.slashArgs = m.slashArgs
      out.slashSource = m.slashSource
    }

    return out
  })
}
