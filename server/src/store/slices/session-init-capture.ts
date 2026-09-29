import type { ConversationInstance } from '@ion/shared/types'
import { appendCut } from '@ion/shared/session-ledger'

/**
 * The patch produced when a `session_init` introduces a (possibly new)
 * conversation id for an instance. Applied onto the instance by the event
 * reducer. Empty object when the id is already known (no-op).
 */
export interface SessionInitCapture {
  conversationIds?: string[]
  sessions?: ConversationInstance['sessions']
  pendingCutReason?: ConversationInstance['pendingCutReason']
}

/**
 * Capture a session_init's sessionId onto an instance: append it to the raw
 * conversationIds chain AND grow the reasoned session ledger.
 *
 * The cut reason is whatever a checkpoint handler stamped on the instance
 * (pendingCutReason) — e.g. Implement clear-context sets 'clear' — defaulting
 * to 'unknown' for the engine's own session lifecycle. appendCut is idempotent
 * on the newest id, so repeated session_inits for the same id never duplicate;
 * parentId linkage falls out of appendCut. The one-shot pending reason is
 * consumed (cleared) when used.
 *
 * Returns {} when the id is already in the chain (nothing to capture). The
 * caller force-flushes persistence on a non-empty return so the id survives a
 * crash between emission and the debounced persist window.
 *
 * Extracted from event-slice.ts to keep that reducer under the 600-line cap.
 */
export function captureSessionInitId(
  inst: Pick<ConversationInstance, 'conversationIds' | 'sessions' | 'pendingCutReason'>,
  sessionId: string,
  now: number,
): SessionInitCapture {
  const existingIds = inst.conversationIds || []
  if (existingIds.includes(sessionId)) return {}

  const reason = inst.pendingCutReason ?? 'unknown'
  const patch: SessionInitCapture = {
    conversationIds: [...existingIds, sessionId],
    sessions: appendCut(inst.sessions ?? [], sessionId, reason, now),
  }
  // Consume the one-shot pending reason.
  if (inst.pendingCutReason) patch.pendingCutReason = undefined
  return patch
}
