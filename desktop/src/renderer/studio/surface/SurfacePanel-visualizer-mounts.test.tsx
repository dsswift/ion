// @vitest-environment jsdom
/**
 * The Visualizer mounts on a browser Studio client. Its reads are `studio.*`
 * actions on every host, so the former `visualizerDirect` placeholder is
 * gone: a surface tab restored from an Electron session renders the real
 * body in a browser tab too.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const visualizerMount = vi.hoisted(() => vi.fn())

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ browserPreviewNetworkShield: true, studioSurfaceSwitchMode: 'preserve' }),
    { getState: () => ({ browserPreviewNetworkShield: true, studioSurfaceSwitchMode: 'preserve' }) },
  ),
}))
const sessionState = { fileEditorStates: new Map(), activeTabId: 'tab-1', tabs: [] as unknown[] }
vi.mock('@ion/server/store/sessionStore', () => {
  const useSessionStore = (selector?: (s: typeof sessionState) => unknown): unknown =>
    (selector ? selector(sessionState) : sessionState)
  return { useSessionStore: Object.assign(useSessionStore, { getState: () => sessionState }) }
})
vi.mock('../../components/git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}))
// SurfacePanel imports GraphSurface (sigma/WebGL), which jsdom cannot construct.
vi.mock('../graph/GraphSurface', () => ({ GraphSurface: () => null }))
vi.mock('./tabs/VisualizerSurface', () => ({
  VisualizerSurface: (...args: unknown[]) => { visualizerMount(...args); return null },
}))

// The browser host's capability set (spec 18), without importing it.
vi.mock('../../host/host-instance', () => ({
  host: {
    shell: {},
    capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'],
  },
}))

import { useSurfaceStore } from './surface-store'
import { SurfacePanel } from './SurfacePanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.clearAllMocks()
  useSurfaceStore.setState({
    tabs: [{ id: 'visualizer', kind: 'singleton' }],
    activeTabId: 'visualizer',
    pinnedTabs: [],
    notification: null,
    conversations: {},
    currentConversationId: 'tab-1',
    visible: true,
    hydrated: true,
    diffReveal: null,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(SurfacePanel, {}))
  })
}

describe('visualizer on a browser host', () => {
  it('mounts VisualizerSurface rather than a placeholder', () => {
    mount()
    expect(visualizerMount).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('not available')
  })
})
