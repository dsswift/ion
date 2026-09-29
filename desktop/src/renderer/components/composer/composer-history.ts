/**
 * Prompt history — the pure navigation rules.
 *
 * The history is this conversation's own user turns; nothing new is stored.
 * ArrowUp walks back from the newest, ArrowDown walks forward and, past the
 * newest, returns the text the operator had before they started walking.
 */
import type { Message } from '@ion/shared/types'
import { suppressesInjection } from '@ion/shared/injection-policy'

/** Prompts the operator typed, oldest first, with immediate repeats collapsed. */
export function promptHistoryFrom(messages: readonly Message[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' || m.userExecuted || suppressesInjection(m)) continue
    const text = m.content.trim()
    if (text.length === 0 || out[out.length - 1] === text) continue
    out.push(text)
  }
  return out
}

export interface HistoryCursor {
  /** Index into the history, or null when not walking it. */
  index: number | null
  /** What the editor held before the walk began. */
  draft: string
}

export const IDLE_HISTORY_CURSOR: HistoryCursor = { index: null, draft: '' }

export interface HistoryStep {
  cursor: HistoryCursor
  /** The text the editor should now show. */
  text: string
}

/**
 * One ArrowUp/ArrowDown press. Returns null when the key is not history's to
 * take, so it falls through to ordinary cursor movement.
 *
 * History takes ArrowUp only from an empty editor or from a recalled entry the
 * operator has not edited, with the cursor on the first line — otherwise
 * ArrowUp in a multi-line prompt could never move the cursor up a line.
 */
export function stepHistory(
  history: readonly string[],
  cursor: HistoryCursor,
  current: string,
  direction: 'back' | 'forward',
  position: { onFirstLine: boolean; onLastLine: boolean },
): HistoryStep | null {
  const walking = cursor.index !== null && history[cursor.index] === current
  if (direction === 'back') {
    if (history.length === 0 || !position.onFirstLine) return null
    if (!walking && current !== '') return null
    const index = walking ? (cursor.index as number) - 1 : history.length - 1
    if (index < 0) return null
    return { cursor: { index, draft: walking ? cursor.draft : current }, text: history[index] }
  }
  if (!walking || !position.onLastLine) return null
  const index = (cursor.index as number) + 1
  if (index >= history.length) return { cursor: IDLE_HISTORY_CURSOR, text: cursor.draft }
  return { cursor: { index, draft: cursor.draft }, text: history[index] }
}
