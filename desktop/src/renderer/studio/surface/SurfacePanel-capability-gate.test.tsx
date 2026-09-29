// @vitest-environment jsdom
/**
 * Capability gate (spec 18): a host lacking `browser` in `capabilities()`
 * (a `BrowserStudioHost`) renders "Not available in the browser" instead of
 * mounting `BrowserSurface` — no `studioBrowserViewEnsure` call, no crash on
 * a bridge that doesn't have it.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ensure = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
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
// See studio-browser-host.test.tsx's identical stub: SurfacePanel imports
// GraphSurface (sigma/WebGL), which jsdom cannot construct.
vi.mock('../graph/GraphSurface', () => ({ GraphSurface: () => null }))

// The capability-less host: `capabilities()` omits 'browser', mirroring
// `BrowserStudioHost` (spec 18) without importing it (which would pull in
// IndexedDB machinery this test does not need).
vi.mock('../../host/host-instance', () => ({
  host: {
    shell: { studioBrowserViewEnsure: ensure },
    capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'],
  },
}))

import { useSurfaceStore } from './surface-store'
import { BrowserBodies } from './SurfacePanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.clearAllMocks()
  useSurfaceStore.setState({
    tabs: [], activeTabId: null, pinnedTabs: [], notification: null, conversations: {},
    currentConversationId: 'tab-1', visible: false, hydrated: true, diffReveal: null,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(BrowserBodies, { currentConversationId: 'tab-1', activeTabId: null }))
  })
}

describe('browser capability gate', () => {
  it('renders the unavailable placeholder instead of mounting BrowserSurface', () => {
    // A background conversation id (distinct from the visible one) so
    // `ensureAgentBrowser` does not itself flip `visible` — this test is
    // only exercising the gate inside `BrowserBodies`.
    act(() => { useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://example.test') })
    mount()
    expect(ensure).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Not available in the browser')
  })
})
