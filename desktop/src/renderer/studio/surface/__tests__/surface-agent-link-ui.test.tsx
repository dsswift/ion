// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
const sessionState = { fileEditorStates: new Map(), activeTabId: 'tab-1', tabs: [] as unknown[] }
vi.mock('../../../stores/sessionStore', () => {
  // Used BOTH as a hook (dirty-path selector in the strip) and via getState
  // (the surface store's conversation fallback), so the mock must be callable.
  const useSessionStore = (selector?: (s: typeof sessionState) => unknown): unknown =>
    (selector ? selector(sessionState) : sessionState)
  return { useSessionStore: Object.assign(useSessionStore, { getState: () => sessionState }) }
})
vi.mock('../../../stores/session-store-helpers', () => ({ editorDirForTab: () => '/repo' }))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ studioSurfaceSwitchMode: 'preserve' }) },
}))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
// Chord hints read preference overrides and global key state; neither is part
// of what this test pins, and stubbing keeps it from depending on either.
vi.mock('../../../shortcuts/useShortcutHints', () => ({ useRevealedShortcuts: () => new Map() }))
vi.mock('../../../components/git/Tooltip', () => ({
  Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) =>
    React.createElement('span', { 'data-tooltip': text }, children),
}))

import { useSurfaceStore } from '../surface-store'
import { SurfaceTabStrip } from '../SurfaceTabStrip'

let container: HTMLDivElement
let root: Root

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(SurfaceTabStrip))
  })
}

/** Count pills carrying the agent-link indicator, found by its tooltip text. */
function linkIndicators(): number {
  return container.querySelectorAll('[data-tooltip^="The agent drives this browser tab"]').length
}

function browserOrder(): string[] {
  return useSurfaceStore.getState().tabs.flatMap((tab) => (tab.kind === 'browser' ? [tab.instanceId] : []))
}

function seedBrowsers(): { linked: string; other: string } {
  const store = useSurfaceStore.getState()
  store.openBrowserTab('https://linked.test', 'browse')
  store.openBrowserTab('https://other.test', 'browse')
  const linked = useSurfaceStore.getState().conversations['tab-1']?.agentBrowserInstanceId ?? ''
  const other = browserOrder().find((id) => id !== linked) ?? ''
  return { linked, other }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ;(window as unknown as { ion: unknown }).ion = {
    studioSetSetting: vi.fn().mockResolvedValue(true),
    studioGetSettings: vi.fn().mockResolvedValue({}),
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
    studioBrowserViewEnsure: vi.fn().mockResolvedValue(true),
    studioBrowserViewBounds: vi.fn(),
    studioBrowserViewNavigate: vi.fn().mockResolvedValue(true),
    studioBrowserViewAction: vi.fn().mockResolvedValue(true),
    studioBrowserViewClose: vi.fn().mockResolvedValue(true),
    onStudioBrowserViewState: vi.fn(() => () => undefined),
  }
  useSurfaceStore.setState({
    tabs: [], activeTabId: null, pinnedTabs: [], notification: null, conversations: {},
    currentConversationId: 'tab-1', visible: true, hydrated: true, diffReveal: null,
  })
  useSurfaceStore.getState().selectConversation(null)
  useSurfaceStore.getState().selectConversation('tab-1')
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

describe('agent-linked browser indicator', () => {
  it('marks exactly one browser pill', () => {
    seedBrowsers()
    mount()
    // With several browser tabs open, the indicator is how the operator knows
    // which page the agent will act on. Exactly one must carry it.
    expect(linkIndicators()).toBe(1)
  })

  it('follows an explicit reassignment and promotes that tab', () => {
    const { other } = seedBrowsers()
    act(() => useSurfaceStore.getState().linkAgentBrowser(other))
    mount()
    expect(linkIndicators()).toBe(1)
    expect(browserOrder()[0]).toBe(other)
  })

  it('disappears when the linked tab closes', () => {
    const { linked } = seedBrowsers()
    act(() => useSurfaceStore.getState().closeTab(`browser:${linked}`))
    mount()
    // The surviving tab must NOT inherit the link: it may be a page the
    // operator prepared for themselves.
    expect(linkIndicators()).toBe(0)
    expect(browserOrder()).toHaveLength(1)
  })

  it('shows no indicator for a conversation with no browser', () => {
    mount()
    expect(linkIndicators()).toBe(0)
  })
})
