/**
 * Transcript-derived rehydration for Guided Questions.
 *
 * ── Why a workflow cannot depend on its own save file ───────────────────────
 *
 * The coordinator persists each workflow under ~/.ion/questions/ so a typed
 * draft survives a restart. That record is a CACHE of the operator's
 * in-progress answers — it is not the authority for whether a question exists.
 *
 * The authority is the conversation transcript. `AskUserQuestions` parks the
 * run, and the engine persists the tool call — title, every question, the
 * tool_use id — into the conversation file like any other turn. That file is
 * the same source the single-question card rebuilds from
 * (`shared/pending-card.ts`), which is exactly why that card survives
 * restarts, reinstalls, and a wiped cache.
 *
 * Guided Questions had no such path, so the workflow existed only as long as
 * its save file did. When a reconnect bug deleted the record, the panel was
 * gone permanently even though the question was sitting in the transcript,
 * unanswered, one line from the end.
 *
 * This module closes that gap: it reads the persisted conversation and
 * reports the parked question when the transcript says one is outstanding.
 * A missing cache now costs the operator their typed draft — never the
 * question itself.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Scanning newest → oldest, the FIRST of these decides:
 *   - a `/clear` divider  → the question was dismissed  → none
 *   - a user turn         → the conversation moved past it → none
 *   - an `AskUserQuestions` tool call → that is the parked question
 *   - any other tool call → the last tool was not a question → none
 *
 * Identical in shape to `pendingCardOutcome`, deliberately: a divergence
 * between the two would mean the tab dot and the panel disagree about whether
 * the operator owes an answer.
 *
 * A machine-authored user turn does NOT count as "moved past it" — an agent
 * callback landing in the conversation is not the operator answering.
 */
import { isClearDivider } from '../../shared/clear-divider'
import { suppressesInjection } from '../../shared/injection-policy'
import { validateQuestionsRequest, type QuestionsRequest } from '../../shared/questions-schema'

/** One persisted row, narrowed to the fields this scan reads. */
export interface TranscriptRow {
  role?: string
  content?: string
  toolName?: string
  toolId?: string
  /** JSON string of the tool's input, as persisted history carries it. */
  toolInput?: string
  injectionKind?: string
  machineAuthored?: boolean
}

/** A parked question recovered from the transcript. */
export interface RehydratedQuestion {
  toolUseId: string
  request: QuestionsRequest
}

/** Why a scan resolved as it did — logged by the caller. */
export type RehydrateOutcome =
  | { kind: 'found'; question: RehydratedQuestion }
  | { kind: 'none' }
  | { kind: 'suppressed-by-clear' }
  | { kind: 'suppressed-by-user' }
  | { kind: 'malformed'; error: string }

/**
 * Decide whether `rows` end with an unanswered AskUserQuestions call.
 *
 * Returns a structured outcome rather than a bare value so the caller can log
 * the reason — "no question" and "question dismissed by /clear" are very
 * different facts when a panel is unexpectedly empty.
 */
export function rehydrateFromTranscript(
  rows: readonly TranscriptRow[] | undefined | null,
): RehydrateOutcome {
  if (!rows || rows.length === 0) return { kind: 'none' }

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]

    if (row.role === 'system' && typeof row.content === 'string' && isClearDivider(row.content)) {
      return { kind: 'suppressed-by-clear' }
    }

    if (row.role === 'user') {
      // A machine-authored turn is not the operator answering: an agent
      // callback or a background-task result landing after the question
      // leaves it just as unanswered as before.
      if (suppressesInjection(row)) continue
      return { kind: 'suppressed-by-user' }
    }

    if (row.toolName) {
      if (row.toolName !== 'AskUserQuestions') return { kind: 'none' }
      if (!row.toolId) return { kind: 'malformed', error: 'tool row has no toolId' }

      let input: unknown
      try {
        input = typeof row.toolInput === 'string' ? JSON.parse(row.toolInput) : row.toolInput
      } catch (err) {
        return { kind: 'malformed', error: `toolInput is not JSON: ${String(err)}` }
      }
      if (typeof input !== 'object' || input === null) {
        return { kind: 'malformed', error: 'toolInput is not an object' }
      }
      // The same validator the live intake uses. A transcript row is not
      // more trusted than a live tool call: a malformed one opens nothing
      // rather than rendering a broken panel.
      const validationError = validateQuestionsRequest(input as Record<string, unknown>)
      if (validationError) return { kind: 'malformed', error: validationError }

      return {
        kind: 'found',
        question: { toolUseId: row.toolId, request: input as unknown as QuestionsRequest },
      }
    }
  }

  return { kind: 'none' }
}
