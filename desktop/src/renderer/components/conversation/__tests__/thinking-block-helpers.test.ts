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
  tailLines,
  buildSummary,
  resolveRenderState,
  isExpandable,
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

describe('tailLines — collapsed/streaming preview', () => {
  it('returns all lines when fewer than n', () => {
    expect(tailLines('a\nb', 3)).toBe('a\nb')
  })

  it('returns exactly n when more than n exist (the LAST n)', () => {
    const text = 'one\ntwo\nthree\nfour\nfive'
    expect(tailLines(text, 3)).toBe('three\nfour\nfive')
  })

  it('uses the configured PREVIEW_LINES count (2-3 line preview)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')
    const out = tailLines(lines, PREVIEW_LINES)
    expect(out.split('\n')).toHaveLength(PREVIEW_LINES)
    // It is the TAIL, so the last line is preserved.
    expect(out.endsWith('line9')).toBe(true)
  })

  it('skips blank lines so the preview is dense', () => {
    const text = 'a\n\n\nb\n\nc'
    expect(tailLines(text, 3)).toBe('a\nb\nc')
  })

  it('returns empty string for empty input', () => {
    expect(tailLines('', 3)).toBe('')
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
