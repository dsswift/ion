import { describe, it, expect } from 'vitest'
import type { Message } from '../../../shared/types-session'
import {
  compactMinimapPreview,
  deriveTimelineMinimapItems,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapTopPercent,
  resolveTooltipTranslate,
} from './TimelineMinimap.logic'

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { timestamp: Date.now(), ...partial } as Message
}

describe('resolveTimelineMinimapHeightStyle', () => {
  it('spaces ticks 8px apart, capped at the viewport budget', () => {
    expect(resolveTimelineMinimapHeightStyle(5)).toBe('min(32px, calc(100vh - 18rem))')
  })

  it('never collapses below 1px', () => {
    expect(resolveTimelineMinimapHeightStyle(1)).toBe('min(1px, calc(100vh - 18rem))')
    expect(resolveTimelineMinimapHeightStyle(0)).toBe('min(1px, calc(100vh - 18rem))')
  })
})

describe('resolveTimelineMinimapTopPercent', () => {
  it('distributes ticks evenly', () => {
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50)
    expect(resolveTimelineMinimapTopPercent(0, 5)).toBe(0)
    expect(resolveTimelineMinimapTopPercent(4, 5)).toBe(100)
  })

  it('clamps out-of-range indexes', () => {
    expect(resolveTimelineMinimapTopPercent(-3, 5)).toBe(0)
    expect(resolveTimelineMinimapTopPercent(99, 5)).toBe(100)
  })

  it('returns 0 for a single item', () => {
    expect(resolveTimelineMinimapTopPercent(0, 1)).toBe(0)
  })
})

describe('resolveTimelineMinimapIndexFromPointer', () => {
  it('resolves the nearest index mid-rail', () => {
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50)
  })

  it('clamps above and below the rail', () => {
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 10,
        railTop: 100,
        railHeight: 500,
        pointerY: 0,
      }),
    ).toBe(0)
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 10,
        railTop: 100,
        railHeight: 500,
        pointerY: 9999,
      }),
    ).toBe(9)
  })

  it('returns null for zero items or a degenerate rail', () => {
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 0,
        railTop: 0,
        railHeight: 500,
        pointerY: 100,
      }),
    ).toBeNull()
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 5,
        railTop: 0,
        railHeight: 0,
        pointerY: 100,
      }),
    ).toBeNull()
  })

  it('returns 0 for a single item', () => {
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 1,
        railTop: 0,
        railHeight: 500,
        pointerY: 400,
      }),
    ).toBe(0)
  })
})

describe('resolveTooltipTranslate', () => {
  it('hangs down at the first tick, up at the last, centered otherwise', () => {
    expect(resolveTooltipTranslate(0, 5)).toBe('0%')
    expect(resolveTooltipTranslate(2, 5)).toBe('-50%')
    expect(resolveTooltipTranslate(4, 5)).toBe('-100%')
  })
})

describe('compactMinimapPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(compactMinimapPreview('  hello\n\n  world\t!')).toBe('hello world !')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(compactMinimapPreview('')).toBeNull()
    expect(compactMinimapPreview('   \n ')).toBeNull()
    expect(compactMinimapPreview(null)).toBeNull()
    expect(compactMinimapPreview(undefined)).toBeNull()
  })
})

describe('deriveTimelineMinimapItems', () => {
  it('pairs each user message with the final assistant text of its turn', () => {
    const items = deriveTimelineMinimapItems([
      msg({ id: 'u1', role: 'user', content: 'first question' }),
      msg({ id: 'a1', role: 'assistant', content: 'draft answer' }),
      msg({ id: 'a2', role: 'assistant', content: 'final answer' }),
      msg({ id: 'u2', role: 'user', content: 'second question' }),
      msg({ id: 'a3', role: 'assistant', content: 'second answer' }),
    ])
    expect(items).toEqual([
      { id: 'u1', userText: 'first question', assistantText: 'final answer' },
      { id: 'u2', userText: 'second question', assistantText: 'second answer' },
    ])
  })

  it('stops the assistant search at the next user message', () => {
    const items = deriveTimelineMinimapItems([
      msg({ id: 'u1', role: 'user', content: 'q1' }),
      msg({ id: 'u2', role: 'user', content: 'q2' }),
      msg({ id: 'a1', role: 'assistant', content: 'answer to q2' }),
    ])
    expect(items[0]).toEqual({ id: 'u1', userText: 'q1', assistantText: null })
    expect(items[1]).toEqual({ id: 'u2', userText: 'q2', assistantText: 'answer to q2' })
  })

  it('skips user messages whose compact text is empty', () => {
    const items = deriveTimelineMinimapItems([
      msg({ id: 'u1', role: 'user', content: '   ' }),
      msg({ id: 'u2', role: 'user', content: '[Attached image: pic.png]\n' }),
      msg({ id: 'u3', role: 'user', content: 'visible' }),
    ])
    expect(items.map((i) => i.id)).toEqual(['u3'])
  })

  it('strips attachment markers from user previews', () => {
    const items = deriveTimelineMinimapItems([
      msg({ id: 'u1', role: 'user', content: '[Attached image: pic.png]\nlook at this' }),
    ])
    expect(items[0].userText).toBe('look at this')
  })

  it('ignores assistant messages with only whitespace content', () => {
    const items = deriveTimelineMinimapItems([
      msg({ id: 'u1', role: 'user', content: 'q' }),
      msg({ id: 'a1', role: 'assistant', content: 'real' }),
      msg({ id: 'a2', role: 'assistant', content: '   ' }),
    ])
    expect(items[0].assistantText).toBe('real')
  })

  it('skips non-user, non-assistant roles when pairing', () => {
    const items = deriveTimelineMinimapItems([
      msg({ id: 'u1', role: 'user', content: 'q' }),
      msg({ id: 's1', role: 'system', content: 'system note' } as Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>),
      msg({ id: 'a1', role: 'assistant', content: 'a' }),
    ])
    expect(items[0].assistantText).toBe('a')
  })
})
