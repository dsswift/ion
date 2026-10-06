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
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) => selector({ tabs: [], activeTabId: null }),
}))
vi.mock('./surface-store', () => ({
  useSurfaceStore: { getState: () => ({}) },
}))

const graphStoreState = { available: false }
vi.mock('../graph/graph-store', () => ({
  useGraphStore: (selector: (s: typeof graphStoreState) => unknown) => selector(graphStoreState),
}))

// Hoisted: the host mock is read at import time (mod-key computes IS_MAC once).
const caps = vi.hoisted(() => ({ list: [] as string[], portForward: null as object | null }))
vi.mock('../../host/host-instance', () => ({
  host: { capabilities: () => caps.list, get portForward() { return caps.portForward } },
}))

import { SurfaceAddMenu } from './SurfaceAddMenu'
import { useEnvironmentSettingsStore } from '../state/environment-settings-store'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

describe('SurfaceAddMenu availability filtering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    graphStoreState.available = false
    caps.list = ['browser']
    caps.portForward = null
  // A full-view connection: the server granted it the terminal scope.
  useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate', 'terminal:operate'])
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
    for (const label of ['Diff', 'Plan Preview', 'Scratch Document', 'Explorer', 'Git', 'Terminal']) {
      expect(labels().some((l) => l.includes(label))).toBe(true)
    }
  })

  it('the Ports entry is present only on a host that can forward ports', () => {
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Ports'))).toBe(false)

    caps.portForward = {}
    act(() => {
      root.render(<SurfaceAddMenu x={1} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Ports'))).toBe(true)
  })

  it('the Visualizer entry is present on every host', () => {
    caps.list = ['terminal', 'git', 'files', 'questions', 'graph']
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Visualizer'))).toBe(true)
  })

  it('the Browser entry is present when the host reports browser', () => {
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Browser'))).toBe(true)
  })

  it('the Browser entry is absent without the browser capability (browser Studio client)', () => {
    // A browser surface tab is an Electron WebContentsView. `SurfacePanel`'s
    // `BrowserBodies` already refuses the body on this capability; the menu
    // must not invite a tab whose body cannot render.
    caps.list = ['terminal', 'git', 'files', 'questions', 'graph']
    act(() => {
      root.render(<SurfaceAddMenu x={0} y={0} onClose={() => {}} />)
    })
    expect(labels().some((l) => l.includes('Browser'))).toBe(false)
  })
})
