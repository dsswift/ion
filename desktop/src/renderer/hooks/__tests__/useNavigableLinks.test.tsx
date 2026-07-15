// @vitest-environment jsdom
//
// Tests for the plan-preview render-cost fix. The change:
//   1. Hoisted segmentText into an unconditional useMemo inside NavigableText /
//      NavigableCode so the link-regex does not re-run for unchanged text.
//   2. Wrapped NavigableText, NavigableCode, LinkSegment, and PlanViewer in
//      React.memo so an unrelated ancestor re-render does not re-parse the plan.
//
// The real hazard introduced by (1) is a conditional-hook reorder: NavigableText
// and NavigableCode both branch on the input (non-string / code-block) and the
// useMemo must sit ABOVE those branches. These tests re-render the SAME fiber
// across those boundaries — on a version that put the hook below the early
// return, React throws the hook-count error. They also pin segmentText output
// and that the memo wrappers are in place.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect } from 'vitest'
import { segmentText, NavigableText, NavigableCode, LinkSegment } from '../useNavigableLinks'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = () => {}

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

describe('segmentText', () => {
  it('splits plain text, file paths, and URLs', () => {
    const segs = segmentText('open src/a/b.ts then visit https://example.com now')
    const files = segs.filter((s) => s.type === 'file').map((s) => s.value)
    const urls = segs.filter((s) => s.type === 'url').map((s) => s.value)
    expect(files).toContain('src/a/b.ts')
    expect(urls).toContain('https://example.com')
  })

  it('returns a single plain segment for text with no links', () => {
    const segs = segmentText('just some words here')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual({ type: 'plain', value: 'just some words here' })
  })
})

describe('NavigableText hook-order stability', () => {
  it('re-renders the same fiber across the string / non-string boundary without a hook error', () => {
    const { root } = mount()
    // string child -> segmentation path
    act(() => root.render(<NavigableText onOpenFile={noop} onOpenUrl={noop}>{'see src/a/b.ts'}</NavigableText>))
    // non-string child -> passthrough path; the useMemo must still run in the
    // same slot or React throws "rendered fewer hooks than expected".
    act(() => root.render(<NavigableText onOpenFile={noop} onOpenUrl={noop}>{[<span key="x">x</span>]}</NavigableText>))
    // back to string
    act(() => root.render(<NavigableText onOpenFile={noop} onOpenUrl={noop}>{'and https://example.com'}</NavigableText>))
    act(() => root.unmount())
  })
})

describe('NavigableCode hook-order stability', () => {
  it('re-renders across the code-block (className) boundary without a hook error', () => {
    const { root } = mount()
    // inline code -> segmentation path
    act(() => root.render(<NavigableCode onOpenFile={noop} onOpenUrl={noop}>{'src/a/b.ts'}</NavigableCode>))
    // fenced code block (has className) -> early passthrough; hook slot preserved
    act(() => root.render(<NavigableCode className="language-ts" onOpenFile={noop} onOpenUrl={noop}>{'const x = 1'}</NavigableCode>))
    // back to inline
    act(() => root.render(<NavigableCode onOpenFile={noop} onOpenUrl={noop}>{'lib/c.ts'}</NavigableCode>))
    act(() => root.unmount())
  })
})

describe('memoization wrappers', () => {
  const MEMO = Symbol.for('react.memo')
  it('wraps the link components in React.memo', () => {
    expect((NavigableText as any).$$typeof).toBe(MEMO)
    expect((NavigableCode as any).$$typeof).toBe(MEMO)
    expect((LinkSegment as any).$$typeof).toBe(MEMO)
  })
})
