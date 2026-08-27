// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ensure = vi.hoisted(() => vi.fn(async () => true))
const bounds = vi.hoisted(() => vi.fn())

vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ browserPreviewNetworkShield: true, studioSurfaceSwitchMode: 'preserve' }),
    { getState: () => ({ browserPreviewNetworkShield: true, studioSurfaceSwitchMode: 'preserve' }) },
  ),
}))
const sessionState = { fileEditorStates: new Map(), activeTabId: 'tab-1', tabs: [] as unknown[] }
vi.mock('../../../stores/sessionStore', () => {
  const useSessionStore = (selector?: (s: typeof sessionState) => unknown): unknown =>
    (selector ? selector(sessionState) : sessionState)
  return { useSessionStore: Object.assign(useSessionStore, { getState: () => sessionState }) }
})
vi.mock('../../../components/git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}))

import { useSurfaceStore } from '../surface-store'
import { StudioBrowserHost } from '../SurfacePanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ;(window as unknown as { ion: unknown }).ion = {
    studioBrowserViewEnsure: ensure,
    studioBrowserViewBounds: bounds,
    studioBrowserViewNavigate: vi.fn().mockResolvedValue(true),
    studioBrowserViewAction: vi.fn().mockResolvedValue(true),
    studioBrowserViewClose: vi.fn().mockResolvedValue(true),
    onStudioBrowserViewState: vi.fn(() => () => undefined),
    studioBrowserSetNetworkShield: vi.fn().mockResolvedValue(true),
    studioSetSetting: vi.fn().mockResolvedValue(true),
    studioGetSettings: vi.fn().mockResolvedValue({}),
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
  }
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
    root.render(React.createElement(StudioBrowserHost))
  })
}

describe('browser guests with the Surface column closed', () => {
  it('creates the guest for a background conversation', () => {
    // The regression: the Surface column is gated on `visible`, so hosting the
    // bodies inside it meant a closed panel created no guest at all and an
    // agent in a background conversation failed with "did not finish loading".
    act(() => { useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test') })
    expect(useSurfaceStore.getState().visible).toBe(false)

    mount()
    expect(ensure).toHaveBeenCalledWith('tab-2', expect.any(String), 'https://background.test', expect.any(String))
  })

  it('keeps every guest hidden while the column is closed', () => {
    act(() => { useSurfaceStore.getState().ensureAgentBrowser('tab-2', 'https://background.test') })
    mount()
    // Running and drivable, but nothing on screen claims the viewport.
    const visibleFlags = bounds.mock.calls.map((call) => call[3])
    expect(visibleFlags.every((flag) => flag === false)).toBe(true)
  })

  it('yields to the column when the panel is open', () => {
    // Two copies measuring one guest would fight over its bounds, so the host
    // steps aside and lets the column own geometry.
    act(() => { useSurfaceStore.getState().ensureAgentBrowser('tab-1', 'https://foreground.test') })
    act(() => { useSurfaceStore.setState({ visible: true }) })
    mount()
    expect(container.firstChild).toBeNull()
  })
})
