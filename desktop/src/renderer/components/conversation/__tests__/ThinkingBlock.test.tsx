// @vitest-environment jsdom
/**
 * ThinkingBlock — layout, color, and font-size tests.
 *
 * Verifies:
 *   (a) The collapsed preview outer container clamps to exactly 3 visual
 *       lines via a CSS maxHeight calc, bottom-anchors content so streamed
 *       text pushes up into overflow, and uses overflow:hidden.
 *   (b) The collapsed text div uses `textTertiary` (#bbb in the mock), NOT
 *       the darker `textMuted` (#aaa) that made the preview unreadable.
 *   (c) The expanded reasoning-text element's inline fontSize is
 *       `calc(var(--ion-conv-font-size, 13px) - 2px)` and it no longer
 *       carries the text-[11px] Tailwind class.
 *   (d) The header-label element keeps fixed text-[11px] (chrome) and does
 *       NOT carry an inline fontSize referencing the zoom variable.
 *
 * Tests (a) and (b) MUST fail on the unfixed code (single flat div with
 * textMuted color and no CSS height clamp) and pass after the fix (outer
 * clamp container + inner text div using textTertiary).
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── Dependency mocks ────────────────────────────────────────────────────────

vi.mock('../../../theme', () => ({
  useColors: () => ({
    textMuted: '#aaa',
    textTertiary: '#bbb',
    textSecondary: '#ccc',
    statusRunning: '#0f0',
    timelineLine: '#ddd',
  }),
}))

// Framer Motion: render children directly with no animation overhead.
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef(
          ({ children, ...rest }: any, ref: any) =>
            React.createElement(tag, { ...rest, ref }, children),
        ),
    },
  )
  const AnimatePresence = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children)
  return { motion, AnimatePresence }
})

vi.mock('@phosphor-icons/react', () => ({
  CaretRight: () => null,
  CaretDown: () => null,
  Brain: () => null,
  LockSimple: () => null,
}))

import { ThinkingBlock } from '../ThinkingBlock'
import type { Message } from '../../../../shared/types'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'thinking',
    content: 'Step one: analyse the problem.\nStep two: solve it.',
    thinkingActive: false,
    thinkingRedacted: false,
    ...overrides,
  } as unknown as Message
}

// ── Collapsed preview layout and color ──────────────────────────────────────

describe('ThinkingBlock — collapsed preview layout and color', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    document.body.removeChild(container)
  })

  it('(a) collapsed outer container carries 3-line maxHeight calc, overflow hidden, and bottom-anchoring', async () => {
    // Long content with no newlines (the defect case: one paragraph that
    // wraps into many visual rows with no structural breaks).
    const longContent = 'This is a very long reasoning paragraph with absolutely no newline characters at all, it just goes on and on and wraps into many visual rows in the DOM without any structural breaks whatsoever, causing dozens of wrapped lines to appear in the collapsed view before the fix was applied.'
    const message = makeMessage({ content: longContent, thinkingActive: false })

    await act(async () => {
      root.render(React.createElement(ThinkingBlock, { message, skipMotion: true }))
    })

    // Do NOT click the header — we are testing the collapsed state.
    const allDivs = Array.from(container.querySelectorAll('div')) as HTMLDivElement[]

    // The outer clamp container: maxHeight calc, overflow:hidden, flex column, justify-end.
    const clampDiv = allDivs.find((d) => {
      const s = d.style
      return (
        s.maxHeight.includes('--ion-conv-font-size') &&
        s.overflow === 'hidden' &&
        s.display === 'flex' &&
        s.flexDirection === 'column' &&
        s.justifyContent === 'flex-end'
      )
    })

    expect(clampDiv).toBeDefined()
    expect(clampDiv!.style.maxHeight).toBe(
      'calc((var(--ion-conv-font-size, 13px) - 2px) * 1.45 * 3)',
    )
    expect(clampDiv!.style.justifyContent).toBe('flex-end')
    expect(clampDiv!.style.overflow).toBe('hidden')
  })

  it('(b) collapsed text div uses textTertiary (#bbb) NOT textMuted (#aaa)', async () => {
    const longContent = 'Another long paragraph with no newlines that used to render as many visual rows and also had a too-dark unreadable color token applied to it making it nearly invisible against the background.'
    const message = makeMessage({ content: longContent, thinkingActive: false })

    await act(async () => {
      root.render(React.createElement(ThinkingBlock, { message, skipMotion: true }))
    })

    // Find the inner text div: has fontSize with --ion-conv-font-size AND contains preview text.
    const allDivs = Array.from(container.querySelectorAll('div')) as HTMLDivElement[]
    const textDiv = allDivs.find((d) => {
      const s = d.style
      return (
        s.fontSize.includes('--ion-conv-font-size') &&
        (d.textContent ?? '').length > 10
      )
    })

    expect(textDiv).toBeDefined()
    // Must use textTertiary (#bbb from the mock), NOT textMuted (#aaa).
    expect(textDiv!.style.color).toBe('rgb(187, 187, 187)') // #bbb parsed by jsdom
    // Sanity: confirm it is not textMuted.
    expect(textDiv!.style.color).not.toBe('rgb(170, 170, 170)') // #aaa
  })
})

// ── Content-vs-chrome font sizing ────────────────────────────────────────────

describe('ThinkingBlock — content-vs-chrome font sizing', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    document.body.removeChild(container)
  })

  it('(c) expanded reasoning-text div uses inline fontSize with zoom variable, not text-[11px]', async () => {
    const message = makeMessage()

    // Render and click to expand.
    await act(async () => {
      root.render(
        React.createElement(ThinkingBlock, { message, skipMotion: true }),
      )
    })

    // Click the header to expand the full reasoning text.
    await act(async () => {
      const header = container.querySelector('[data-ion-ui]') as HTMLElement | null
      expect(header).not.toBeNull()
      header!.click()
    })

    // Find all divs whose inline fontSize references the zoom variable.
    const allDivs = Array.from(container.querySelectorAll('div'))
    const zoomScaledDivs = allDivs.filter((div) => {
      const fs = (div as HTMLElement).style.fontSize
      return fs.includes('--ion-conv-font-size')
    })

    expect(zoomScaledDivs.length).toBeGreaterThanOrEqual(1)

    // Every zoom-scaled div must NOT carry the Tailwind fixed-size class.
    for (const div of zoomScaledDivs) {
      expect(div.classList.contains('text-[11px]')).toBe(false)
    }

    // At least one zoom-scaled div contains the full reasoning text.
    const reasoningDiv = zoomScaledDivs.find((div) =>
      div.textContent?.includes('Step one: analyse the problem'),
    )
    expect(reasoningDiv).toBeDefined()
    expect((reasoningDiv as HTMLElement).style.fontSize).toBe(
      'calc(var(--ion-conv-font-size, 13px) - 2px)',
    )
  })

  it('(d) header-label span keeps fixed text-[11px] and does NOT reference the zoom variable', async () => {
    const message = makeMessage()

    await act(async () => {
      root.render(
        React.createElement(ThinkingBlock, { message, skipMotion: true }),
      )
    })

    // The header label is the span containing the summary / "Reasoning" text.
    const allSpans = Array.from(container.querySelectorAll('span'))
    const labelSpan = allSpans.find((span) =>
      span.textContent?.includes('Reasoning') ||
      span.textContent?.includes('Thought'),
    )

    expect(labelSpan).toBeDefined()
    expect(labelSpan!.classList.contains('text-[11px]')).toBe(true)
    expect((labelSpan as HTMLElement).style.fontSize).not.toContain('--ion-conv-font-size')
  })
})
