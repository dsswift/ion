// @vitest-environment jsdom
/**
 * Tests for SurfaceAddMenu.tsx (child 05): availability filtering. The
 * Graph entry is present only when `graphViewAvailable` is true; every
 * existing entry with no `available` predicate is always shown.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../hooks/useAnchoredPopover', () => ({
  useAnchoredPopover: () => ({ ref: () => {}, left: 0, top: 0, ready: true }),
}))
vi.mock('../../hooks/useInteractiveState', () => ({
  useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }),
  interactiveBg: () => 'transparent',
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) => selector({ tabs: [], activeTabId: null }),
}))
vi.mock('./surface-store', () => ({
  useSurfaceStore: { getState: () => ({}) },
}))

const graphStoreState = { available: false }
vi.mock('../graph/graph-store', () => ({
  useGraphStore: (selector: (s: typeof graphStoreState) => unknown) => selector(graphStoreState),
}))

import { SurfaceAddMenu } from './SurfaceAddMenu'

describe('SurfaceAddMenu availability filtering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    graphStoreState.available = false
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function labels(): string[] {
    return [...document.querySelectorAll('button')].map((b) => b.textContent ?? '')
  }

  it('the Graph entry is absent when graphViewAvailable is false', () => {
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Graph'))).toBe(false)
  })

  it('the Graph entry is present when graphViewAvailable is true', () => {
    graphStoreState.available = true
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Graph'))).toBe(true)
  })

  it('every entry with no available predicate is always present', () => {
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    for (const label of ['Diff', 'Plan Preview', 'Visualizer', 'Scratch Document', 'Explorer', 'Git', 'Browser', 'Terminal']) {
      expect(labels().some((l) => l.includes(label))).toBe(true)
    }
  })
})
