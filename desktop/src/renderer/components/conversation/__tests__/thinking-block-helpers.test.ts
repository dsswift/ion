/**
 * thinking-block-helpers — ThinkingBlock render-state logic (issue #158)
 *
 * The desktop test suite runs in the `node` vitest environment with no
 * React DOM renderer, so the ThinkingBlock component's *decision* logic is
 * extracted into pure helpers (thinking-block-helpers.ts) and pinned here.
 * These tests cover the three render states the component selects between:
 *
 *   - live (streaming): tail preview, expandable while text present.
 *   - historical-with-text: collapsed shows the last N lines, expand reveals
 *     the full text.
 *   - summary-only: no text — renders the elapsed/token summary or the
 *     redacted affordance, never promising text it does not have.
 */

import { describe, it, expect } from 'vitest'
import {
  PREVIEW_LINES,
  PREVIEW_CHAR_BUDGET,
  tailForPreview,
  buildSummary,
  resolveRenderState,
  isExpandable,
  mergeThinkingMessages,
} from '../thinking-block-helpers'
import type { Message } from '../../../../shared/types'

function thinking(partial: Partial<Message>): Message {
  return {
    id: 't1',
    role: 'thinking',
    content: '',
    timestamp: 0,
    ...partial,
  } as Message
}

describe('tailForPreview — collapsed/streaming preview character budget', () => {
  it('returns short input unchanged (≤ maxChars)', () => {
    expect(tailForPreview('hello world', 600)).toBe('hello world')
    expect(tailForPreview('', 600)).toBe('')
  })

  it('returns the trailing slice when input exceeds maxChars', () => {
    const long = 'x'.repeat(700)
    const result = tailForPreview(long, 600)
    expect(result.length).toBeLessThanOrEqual(600)
    expect(long.endsWith(result)).toBe(true)
  })

  it('cuts at a clean line boundary (drops partial leading line)', () => {
    // Build a string where the 600-char budget cuts mid-line.
    // "prefix\nclean line that ends at budget edge"
    const prefix = 'partial leading line content'
    const filler = 'a'.repeat(600 - prefix.length - 1) // just under the newline
    const text = prefix + '\n' + filler
    // text.length = 600, so tailForPreview returns it unchanged
    // Make it longer so the cut actually triggers:
    const long = 'extra' + text
    const result = tailForPreview(long, 600)
    // The result must not start with the partial content that precedes the first \n
    expect(result.startsWith('\n')).toBe(false)
    // It must be a clean start (no partial line before the first newline in the slice)
    // i.e. the slice that was taken ends with `filler`, starting after a newline
    expect(result).toBe(filler)
  })

  it('returns the whole slice when no newline exists in the budget window', () => {
    // One long paragraph with no newlines — the whole 600-char tail is returned.
    const long = 'z'.repeat(1000)
    const result = tailForPreview(long, 600)
    expect(result).toBe('z'.repeat(600))
  })

  it('uses PREVIEW_CHAR_BUDGET as the default budget (exported constant is 600)', () => {
    expect(PREVIEW_CHAR_BUDGET).toBe(600)
    // Short text passes through unchanged at the default budget.
    const short = 'some reasoning text'
    expect(tailForPreview(short, PREVIEW_CHAR_BUDGET)).toBe(short)
  })

  it('PREVIEW_LINES constant is still 3 (CSS clamp multiplier)', () => {
    expect(PREVIEW_LINES).toBe(3)
  })
})

describe('buildSummary — block_end summary string', () => {
  it('redacted takes precedence and never promises text', () => {
    const s = buildSummary(thinking({ thinkingRedacted: true, thinkingElapsedSeconds: 9 }))
    expect(s).toBe('🔒 redacted reasoning')
  })

  it('formats elapsed + tokens like "💭 Thought for 14s · 3,200 tokens"', () => {
    const s = buildSummary(thinking({ thinkingElapsedSeconds: 14, thinkingTotalTokens: 3200 }))
    expect(s).toBe('💭 Thought for 14s · 3,200 tokens')
  })

  it('formats elapsed only when tokens absent', () => {
    const s = buildSummary(thinking({ thinkingElapsedSeconds: 8 }))
    expect(s).toBe('💭 Thought for 8s')
  })

  it('formats tokens only when elapsed absent', () => {
    const s = buildSummary(thinking({ thinkingTotalTokens: 1500 }))
    expect(s).toBe('💭 Thought · 1,500 tokens')
  })

  it('returns empty when neither field is present (the live, pre-end state)', () => {
    expect(buildSummary(thinking({}))).toBe('')
  })
})

describe('resolveRenderState — three-state selection', () => {
  it('live while thinkingActive, regardless of text', () => {
    expect(resolveRenderState(thinking({ thinkingActive: true }))).toBe('live')
    expect(resolveRenderState(thinking({ thinkingActive: true, content: 'partial' }))).toBe('live')
  })

  it('historical-text when sealed with non-empty content', () => {
    expect(resolveRenderState(thinking({ thinkingActive: false, content: 'reasoning' }))).toBe('historical-text')
  })

  it('summary-only when sealed with no content', () => {
    expect(resolveRenderState(thinking({ thinkingActive: false, content: '' }))).toBe('summary-only')
  })

  it('summary-only when redacted (no text ever present)', () => {
    expect(resolveRenderState(thinking({ thinkingActive: false, thinkingRedacted: true, content: '' }))).toBe('summary-only')
  })

  it('whitespace-only content is treated as no text', () => {
    expect(resolveRenderState(thinking({ thinkingActive: false, content: '   \n  ' }))).toBe('summary-only')
  })
})

describe('isExpandable — expand affordance gating', () => {
  it('expandable when text present (historical)', () => {
    expect(isExpandable(thinking({ thinkingActive: false, content: 'text' }))).toBe(true)
  })

  it('expandable while live with text (pin-open during stream)', () => {
    expect(isExpandable(thinking({ thinkingActive: true, content: 'streaming' }))).toBe(true)
  })

  it('NOT expandable when summary-only (nothing to reveal)', () => {
    expect(isExpandable(thinking({ thinkingActive: false, content: '' }))).toBe(false)
  })

  it('NOT expandable when redacted', () => {
    expect(isExpandable(thinking({ thinkingActive: false, thinkingRedacted: true, content: '' }))).toBe(false)
  })
})

describe('mergeThinkingMessages — one thought row per turn (unified view)', () => {
  it('returns a single row unchanged (no synthesis)', () => {
    const m = thinking({ id: 'only', content: 'solo', thinkingElapsedSeconds: 4 })
    expect(mergeThinkingMessages([m])).toBe(m)
  })

  it('uses the FIRST row id for stable identity (no remount as blocks arrive)', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', content: 'one' }),
      thinking({ id: 'b', content: 'two' }),
    ])
    expect(merged.id).toBe('a')
  })

  it('joins non-empty contents with a blank line, preserving order', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', content: 'one' }),
      thinking({ id: 'b', content: '' }),
      thinking({ id: 'c', content: 'three' }),
    ])
    expect(merged.content).toBe('one\n\nthree')
  })

  it('stays live while ANY row is active', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', content: 'sealed', thinkingActive: false }),
      thinking({ id: 'b', content: 'streaming', thinkingActive: true }),
    ])
    expect(merged.thinkingActive).toBe(true)
  })

  it('is sealed when every row is sealed', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', thinkingActive: false }),
      thinking({ id: 'b', thinkingActive: false }),
    ])
    expect(merged.thinkingActive).toBe(false)
  })

  it('sums elapsed seconds and token estimates across rows', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', thinkingElapsedSeconds: 2.5, thinkingTotalTokens: 100 }),
      thinking({ id: 'b', thinkingElapsedSeconds: 3.5, thinkingTotalTokens: 250 }),
    ])
    expect(merged.thinkingElapsedSeconds).toBe(6)
    expect(merged.thinkingTotalTokens).toBe(350)
  })

  it('leaves summary fields undefined when no row carried them', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', content: 'one' }),
      thinking({ id: 'b', content: 'two' }),
    ])
    expect(merged.thinkingElapsedSeconds).toBeUndefined()
    expect(merged.thinkingTotalTokens).toBeUndefined()
  })

  it('sums partial summary coverage (one row with data, one without)', () => {
    const merged = mergeThinkingMessages([
      thinking({ id: 'a', thinkingElapsedSeconds: 7 }),
      thinking({ id: 'b' }),
    ])
    expect(merged.thinkingElapsedSeconds).toBe(7)
    expect(merged.thinkingTotalTokens).toBeUndefined()
  })

  it('is redacted only when EVERY row is redacted', () => {
    const allRedacted = mergeThinkingMessages([
      thinking({ id: 'a', thinkingRedacted: true }),
      thinking({ id: 'b', thinkingRedacted: true }),
    ])
    expect(allRedacted.thinkingRedacted).toBe(true)

    const mixed = mergeThinkingMessages([
      thinking({ id: 'a', thinkingRedacted: true }),
      thinking({ id: 'b', content: 'readable', thinkingRedacted: false }),
    ])
    expect(mixed.thinkingRedacted).toBe(false)
    expect(mixed.content).toBe('readable')
  })
})
