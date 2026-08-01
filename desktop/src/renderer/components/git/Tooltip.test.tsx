// @vitest-environment jsdom
//
// Tooltip — the wrapper span is the flex item, and callers must be able to style it.
//
// The failure this pins: the wrapper carried a hardcoded `display: inline-flex`
// and nothing else, so wherever a tooltipped element sat in a flex row the
// wrapper was the real flex ITEM and had no `minWidth: 0`. Its automatic minimum
// size was therefore the child's full intrinsic width, and a caller that set
// `flexShrink: 1` + `overflow: hidden` on its own text got no ellipsis — the row
// overflowed instead. That is what made the git panel's worktree rows scroll
// sideways and pushed their controls out of reach.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
// No popover layer in the test tree, which is also the fallback path where
// Tooltip uses the native `title` attribute.
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => null }))

import { Tooltip } from './Tooltip'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Tooltip', () => {
  it('merges a caller style onto the wrapper so the wrapped element can shrink', () => {
    act(() => {
      root.render(React.createElement(
        Tooltip,
        {
          text: 'Branch wt/a1',
          style: { minWidth: 0, flex: 1, overflow: 'hidden' },
          children: React.createElement('span', { 'data-testid': 'child' }, 'a-very-long-label'),
        },
      ))
    })

    const wrapper = (host.querySelector('[data-testid="child"]') as HTMLElement).parentElement!
    expect(wrapper.style.minWidth).toBe('0px')
    expect(wrapper.style.flex).toContain('1')
    expect(wrapper.style.overflow).toBe('hidden')
    // The layout mode the component owns survives the merge.
    expect(wrapper.style.display).toBe('inline-flex')
  })

  it('keeps its own display when no style is passed', () => {
    act(() => {
      root.render(React.createElement(
        Tooltip,
        {
          text: 'Clean',
          children: React.createElement('span', { 'data-testid': 'child' }, 'dot'),
        },
      ))
    })

    const wrapper = (host.querySelector('[data-testid="child"]') as HTMLElement).parentElement!
    expect(wrapper.style.display).toBe('inline-flex')
    expect(wrapper.style.minWidth).toBe('')
  })
})
