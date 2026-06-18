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

/** Number of trailing lines shown in the collapsed/streaming preview. */
export const PREVIEW_LINES = 3

/**
 * The three render states ThinkingBlock can be in. Exported so tests (and
 * any future consumer) can assert the chosen state directly rather than
 * inferring it from rendered output.
 */
export type ThinkingRenderState = 'live' | 'historical-text' | 'summary-only'

/** Return the last `n` non-empty lines of `text`, joined for the preview. */
export function tailLines(text: string, n: number): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length <= n) return lines.join('\n')
  return lines.slice(lines.length - n).join('\n')
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
