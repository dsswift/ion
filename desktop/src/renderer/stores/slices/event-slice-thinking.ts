import type { Message, NormalizedEvent } from '../../../shared/types'
import { nextMsgId } from '../session-store-helpers'

// ---------------------------------------------------------------------------
// Extended thinking (issue #158) — normalized-stream reducer helpers.
//
// These pure helpers materialize `role: 'thinking'` rows from the
// normalized-stream `thinking_*` events for PLAIN conversations. They mirror
// the extension-hosted path in engine-event-slice.ts but operate on the
// normalized-stream reducer's working `messages` array (event-slice.ts) and
// return a new array, so they slot directly into that reducer's switch without
// touching its closure state. Extracted to keep event-slice.ts under the
// 600-line TypeScript cap.
//
// A thinking block is OPTIONAL per turn. Boundaries (start/end) always arrive
// when reasoning happened; the per-token delta may be suppressed engine-side
// (the summary-only path). See ThinkingBlock.tsx for the three render states.
// ---------------------------------------------------------------------------

/** Index of the most recent still-active thinking row, or -1 if none. */
function findActiveThinkingIdx(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'thinking' && messages[i].thinkingActive) return i
  }
  return -1
}

/**
 * thinking_block_start: the model began a reasoning block. Open a fresh
 * `role: 'thinking'` row with `thinkingActive: true` (drives the live pulse
 * until block_end). Openable from the boundary alone — deltas may never
 * arrive (summary-only path).
 */
export function applyThinkingBlockStart(messages: Message[]): Message[] {
  return [
    ...messages,
    {
      id: nextMsgId(),
      role: 'thinking' as const,
      content: '',
      thinkingActive: true,
      timestamp: Date.now(),
    },
  ]
}

/**
 * thinking_delta: incremental reasoning text. Append to the open (active)
 * thinking row. If none exists (a delta arrived before block_start — e.g. a
 * dropped/reordered start), open one defensively so the text is not lost.
 */
export function applyThinkingDelta(
  messages: Message[],
  event: Extract<NormalizedEvent, { type: 'thinking_delta' }>,
): Message[] {
  const text = event.text || ''
  if (!text) return messages
  const idx = findActiveThinkingIdx(messages)
  if (idx === -1) {
    return [
      ...messages,
      {
        id: nextMsgId(),
        role: 'thinking' as const,
        content: text,
        thinkingActive: true,
        timestamp: Date.now(),
      },
    ]
  }
  return messages.map((m, i) => (i === idx ? { ...m, content: m.content + text } : m))
}

/**
 * thinking_block_end: the reasoning block finished. Seal the active thinking
 * row — clear thinkingActive (stops the pulse) and stamp the summary fields
 * (elapsed seconds, token estimate, redacted flag). If no active row exists
 * (start was dropped, or block_end arrived twice), synthesize a summary-only
 * row so the user still sees that the model reasoned this turn.
 */
export function applyThinkingBlockEnd(
  messages: Message[],
  event: Extract<NormalizedEvent, { type: 'thinking_block_end' }>,
): Message[] {
  const redacted = !!event.redacted
  const idx = findActiveThinkingIdx(messages)
  if (idx === -1) {
    return [
      ...messages,
      {
        id: nextMsgId(),
        role: 'thinking' as const,
        content: '',
        thinkingActive: false,
        thinkingElapsedSeconds: event.elapsedSeconds,
        thinkingTotalTokens: event.totalTokens,
        thinkingRedacted: redacted,
        timestamp: Date.now(),
      },
    ]
  }
  return messages.map((m, i) =>
    i === idx
      ? {
          ...m,
          thinkingActive: false,
          thinkingElapsedSeconds: event.elapsedSeconds,
          thinkingTotalTokens: event.totalTokens,
          thinkingRedacted: redacted,
        }
      : m,
  )
}

/**
 * stream_reset: the engine is retrying mid-turn. Drop any still-active
 * thinking row (thinkingActive=true). A SEALED thinking row from earlier in
 * the same turn is real history and must survive the retry. Returns the input
 * unchanged when there is no active row to discard.
 */
export function discardActiveThinking(messages: Message[]): Message[] {
  if (!messages.some((m) => m.role === 'thinking' && m.thinkingActive)) return messages
  return messages.filter((m) => !(m.role === 'thinking' && m.thinkingActive))
}

/**
 * Dispatch the three plain-conversation thinking events
 * (thinking_block_start / thinking_delta / thinking_block_end) to the matching
 * apply* helper above. Returns the new `messages` array, or `null` when `event`
 * is not a thinking event — letting the caller fall through to its main switch.
 *
 * Extracted from event-slice.ts so the reducer's switch carries one guarded
 * call instead of three cases, keeping that file under the 600-line cap. The
 * thinking reducer logic stays fully owned by this module.
 */
export function handleThinkingEvent(messages: Message[], event: NormalizedEvent): Message[] | null {
  switch (event.type) {
    case 'thinking_block_start':
      return applyThinkingBlockStart(messages)
    case 'thinking_delta':
      return applyThinkingDelta(messages, event)
    case 'thinking_block_end':
      return applyThinkingBlockEnd(messages, event)
    default:
      return null
  }
}
