import type { Message } from '../../../shared/types'

/**
 * Pure presentation logic for ThinkingBlock (issue #158, Phase 3 desktop).
 *
 * Extracted from ThinkingBlock.tsx so the three-state decision logic can be
 * unit-tested without a DOM (the desktop test suite runs in the `node`
 * vitest environment with no React DOM renderer). ThinkingBlock.tsx imports
 * these helpers and renders their results.
 *
 * The component picks one of THREE render states from a synthesized
 * `role: 'thinking'` Message — never promising text it does not have:
 *
 *   1. LIVE (`thinkingActive === true`): streaming. Pulse + tail of content.
 *   2. HISTORICAL-WITH-TEXT (`!thinkingActive`, non-empty content): collapsed
 *      shows the tail, expanding reveals the full text.
 *   3. SUMMARY-ONLY (`!thinkingActive`, empty content): deltas were disabled,
 *      the block was redacted, or the row was rehydrated without text. Renders
 *      the elapsed/token summary (or the redacted affordance); nothing to
 *      expand.
 */

/**
 * Number of VISUAL lines shown in the collapsed/streaming preview. Used as
 * the multiplier in the CSS height clamp (`maxHeight` calc) — not a
 * logical-line count. Correctness of "3 lines shown" comes from the CSS
 * clamp, not from text truncation.
 */
export const PREVIEW_LINES = 3

/**
 * Character budget passed to `tailForPreview`. Bounds the DOM/layout work
 * during streaming by keeping the preview slice small; the CSS clamp
 * enforces the visible line count independently.
 */
export const PREVIEW_CHAR_BUDGET = 600

/**
 * The three render states ThinkingBlock can be in. Exported so tests (and
 * any future consumer) can assert the chosen state directly rather than
 * inferring it from rendered output.
 */
export type ThinkingRenderState = 'live' | 'historical-text' | 'summary-only'

/**
 * Return the trailing slice of `text` bounded to `maxChars` characters, cut
 * at a clean line boundary. If the slice starts mid-line (i.e. the cut lands
 * in the middle of a line), the partial leading line is dropped by trimming
 * to the first `\n`. Short input (≤ maxChars) is returned unchanged.
 *
 * This function only bounds DOM/layout work during streaming. The visible
 * line count is enforced by the CSS height clamp in ThinkingBlock, not by
 * this function.
 */
export function tailForPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(text.length - maxChars)
  const newlineIdx = slice.indexOf('\n')
  // If there is no newline in the slice the entire slice is one paragraph;
  // return it as-is (the CSS clamp will hide the overflow).
  if (newlineIdx === -1) return slice
  return slice.slice(newlineIdx + 1)
}

/**
 * Build the human-readable summary string from the block_end fields.
 * Returns '' when no summary is available (the live, pre-block_end state).
 *
 *   - redacted → "🔒 redacted reasoning" (highest precedence; no text).
 *   - elapsed and/or tokens present → "💭 Thought for {n}s · {t} tokens".
 *   - neither present → '' (caller shows a neutral label).
 */
export function buildSummary(message: Message): string {
  if (message.thinkingRedacted) return '🔒 redacted reasoning'
  const secs = message.thinkingElapsedSeconds
  const toks = message.thinkingTotalTokens
  if (secs == null && toks == null) return ''
  const parts: string[] = ['💭']
  if (secs != null) {
    parts.push(`Thought for ${secs}s`)
  } else {
    parts.push('Thought')
  }
  if (toks != null) parts.push(`· ${toks.toLocaleString()} tokens`)
  return parts.join(' ')
}

/**
 * Resolve the render state for a thinking message. Mirrors the precedence
 * the component uses: active wins (live), then non-empty text (historical),
 * then summary-only. Redacted rows always fall into summary-only (they
 * never carry text).
 */
export function resolveRenderState(message: Message): ThinkingRenderState {
  if (message.thinkingActive) return 'live'
  const hasText = (message.content || '').trim().length > 0
  return hasText ? 'historical-text' : 'summary-only'
}

/**
 * Whether the block can be expanded to reveal the full reasoning text.
 * True whenever the row carries non-empty text — including a LIVE block,
 * so the user can pin the full reasoning open while it streams. Only the
 * summary-only state (no text) is non-expandable: there is nothing to
 * reveal beyond the header. This matches ThinkingBlock's `expandable`.
 */
export function isExpandable(message: Message): boolean {
  return (message.content || '').trim().length > 0
}

/**
 * Merge all of a turn's thinking rows into ONE display message (unified
 * turn view). A single run makes many API rounds and each round opens its
 * own thinking block, so a turn can accumulate dozens of `role: 'thinking'`
 * rows. The unified view shows exactly one thought stream per turn; this
 * helper synthesizes it. Display-level only — the underlying messages are
 * never mutated, so history, persistence, and the classic view see the
 * original rows.
 *
 * Field rules:
 *   - id: the FIRST row's id. Stable identity across re-groups, so the
 *     merged row does not remount (no scroll jump) as later blocks arrive.
 *   - content: non-empty contents joined with a blank line, preserving
 *     block order — one continuous reasoning stream.
 *   - thinkingActive: true if ANY row is still active. The live pulse
 *     survives the boundaries between blocks within the same run.
 *   - thinkingElapsedSeconds / thinkingTotalTokens: summed across rows
 *     (undefined when no row carried the field, so the summary renders
 *     exactly like a single block with no data).
 *   - thinkingRedacted: true only when EVERY row is redacted. A mix of
 *     redacted and readable blocks shows the readable text.
 *
 * Single-row input returns the row unchanged (no synthesis needed).
 */
export function mergeThinkingMessages(msgs: Message[]): Message {
  if (msgs.length === 1) return msgs[0]

  const contents = msgs.map((m) => m.content || '').filter((c) => c.trim().length > 0)

  let elapsed: number | undefined
  let tokens: number | undefined
  for (const m of msgs) {
    if (m.thinkingElapsedSeconds != null) elapsed = (elapsed ?? 0) + m.thinkingElapsedSeconds
    if (m.thinkingTotalTokens != null) tokens = (tokens ?? 0) + m.thinkingTotalTokens
  }

  return {
    ...msgs[0],
    content: contents.join('\n\n'),
    thinkingActive: msgs.some((m) => !!m.thinkingActive),
    thinkingElapsedSeconds: elapsed,
    thinkingTotalTokens: tokens,
    thinkingRedacted: msgs.every((m) => !!m.thinkingRedacted),
  }
}
