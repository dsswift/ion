import { isClearDivider } from './clear-divider'

/**
 * pending-card — the single, shared rule for deciding whether a persisted
 * conversation should restore a pending AskUserQuestion / ExitPlanMode card.
 *
 * Why this exists: ten call sites across restoration / resume / rewind used to
 * each re-derive "the last tool message is AskUserQuestion or ExitPlanMode →
 * restore the card" with an ad-hoc `[...msgs].reverse().find(m => m.toolName)`
 * scan. None of them treated a trailing `/clear` divider as a dismissal, so a
 * conversation that was cleared *after* its last pending question would
 * resurrect the card on reopen — the exact defect behind the reported bug
 * (the engine had already dropped the denial; the card was a client-side
 * restoration artifact rebuilt from the preserved history).
 *
 * This helper centralizes the rule and adds the missing guard: a pending card
 * is restored only when the last AskUserQuestion / ExitPlanMode tool message
 * is genuinely still outstanding — i.e. NO `/clear` divider and NO user
 * message appears after it. A `/clear` is a checkpoint that dismisses the
 * pending question; a user message means the conversation moved past it.
 */

/** The two intercepted tools that produce a restorable pending card. */
const PENDING_CARD_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const

/**
 * Minimal message shape this rule reads. Call sites pass their own message
 * objects (renderer `Message`, persisted message records, etc.); only these
 * fields are inspected so the helper works across all of them.
 */
export interface PendingCardMessage {
  role?: string
  content?: string
  toolName?: string
  toolId?: string
  toolInput?: string
}

/** Why a scan resolved the way it did — surfaced for logging at call sites. */
export type PendingCardOutcome =
  | { kind: 'found'; toolName: string; toolId?: string; toolInput?: string }
  | { kind: 'none' }
  | { kind: 'suppressed-by-clear' }
  | { kind: 'suppressed-by-user' }

/**
 * Walk `messages` from the end and decide whether a pending card should be
 * restored. Returns a structured outcome so callers can both act on it and log
 * the decision (per the ultra-logging mandate) without re-deriving it.
 *
 * Rules, evaluated newest → oldest:
 *   - A `/clear` divider (system message whose content starts with the clear
 *     sentinel) → the pending question was dismissed → `suppressed-by-clear`.
 *   - A user message → the conversation continued past the question →
 *     `suppressed-by-user`.
 *   - An AskUserQuestion / ExitPlanMode tool message reached before either of
 *     the above → `found` (this is the card to restore).
 *   - Any other tool message reached first → `none` (the last tool was not a
 *     pending-card tool, so there is no card).
 *   - End of history with no tool message → `none`.
 */
export function pendingCardOutcome(messages: readonly PendingCardMessage[] | undefined | null): PendingCardOutcome {
  if (!messages || messages.length === 0) return { kind: 'none' }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // A clear divider dismisses any earlier pending question.
    if (m.role === 'system' && typeof m.content === 'string' && isClearDivider(m.content)) {
      return { kind: 'suppressed-by-clear' }
    }
    // A user message means the conversation moved past the question.
    if (m.role === 'user') {
      return { kind: 'suppressed-by-user' }
    }
    // The first tool message we hit decides the outcome: if it's a
    // pending-card tool it's restorable; otherwise there is no card.
    if (m.toolName) {
      if ((PENDING_CARD_TOOLS as readonly string[]).includes(m.toolName)) {
        return { kind: 'found', toolName: m.toolName, toolId: m.toolId, toolInput: m.toolInput }
      }
      return { kind: 'none' }
    }
  }
  return { kind: 'none' }
}

/**
 * Convenience wrapper that returns the restorable pending tool message's
 * identifying fields, or null when no card should be restored. Most call sites
 * want exactly this — they build a `{ tools: [{ toolName, toolUseId,
 * toolInput }] }` permissionDenied entry from the result. Callers that also
 * want to log the suppression reason use `pendingCardOutcome` directly.
 */
export function lastPendingCardTool(
  messages: readonly PendingCardMessage[] | undefined | null,
): { toolName: string; toolId?: string; toolInput?: string } | null {
  const outcome = pendingCardOutcome(messages)
  if (outcome.kind === 'found') {
    return { toolName: outcome.toolName, toolId: outcome.toolId, toolInput: outcome.toolInput }
  }
  return null
}
