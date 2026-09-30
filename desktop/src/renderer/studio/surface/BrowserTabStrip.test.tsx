// @vitest-environment jsdom
/**
 * The Browser slot's document strip.
 *
 * Pins that switching a document is a plain `activateTab`, that closing the
 * shown document lands on its strip neighbour rather than on whatever follows
 * it in the outer bar, and that the strip renders on a host WITHOUT the
 * `browser` capability while calling no Electron-only verb at all.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shell = vi.hoisted(() => new Proxy({}, {
  get: (_target, verb) => { throw new Error(`Electron-only verb called on the web host: ${String(verb)}`) },
}))

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ studioSurfaceSwitchMode: 'preserve' }),
    { getState: () => ({ studioSurfaceSwitchMode: 'preserve' }) },
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
vi.mock('../../host/host-instance', () => ({
  host: { shell, capabilities: () => ['terminal', 'git', 'files'] },
}))

import { useSurfaceStore } from './surface-store'
import { BrowserTabStrip } from './BrowserTabStrip'
import type { SurfaceTab } from '@ion/shared/studio-surface-types'

function browser(instanceId: string, title: string): SurfaceTab {
  return { kind: 'browser', id: `browser:${instanceId}`, instanceId, url: `https://${instanceId}.example.org`, title, mode: 'browse', sessionMode: 'shared' }
}
const terminal: SurfaceTab = { kind: 'terminal', id: 'terminal:t1', instanceId: 't1', cwd: '/repo', title: 'Terminal 1' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  const tabs = [browser('b1', 'One'), terminal, browser('b2', 'Two')]
  useSurfaceStore.setState({
    tabs, activeTabId: 'browser:b1', pinnedTabs: [], notification: null,
    conversations: { 'tab-1': { tabs, activeTabId: 'browser:b1', visible: true, width: null, agentBrowserInstanceId: 'b2', activeBrowserInstanceId: 'b1' } },
    currentConversationId: 'tab-1', visible: true, hydrated: true, diffReveal: null,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(BrowserTabStrip))
  })
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
}

describe('BrowserTabStrip', () => {
  it('lists every document with the agent-linked one first, on a host without the browser capability', () => {
    mount()
    expect(rows().map((row) => row.textContent?.replace('×', '').trim())).toEqual(['Two', 'One'])
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('switches documents through activateTab', () => {
    mount()
    act(() => { rows()[0]!.click() })
    expect(useSurfaceStore.getState().activeTabId).toBe('browser:b2')
    expect(useSurfaceStore.getState().conversations['tab-1']?.activeBrowserInstanceId).toBe('b2')
  })

  it('closing the shown document lands on its strip neighbour, not the terminal beside it', () => {
    mount()
    act(() => { rows()[1]!.querySelector<HTMLElement>('[aria-label="Close One"]')!.click() })
    const state = useSurfaceStore.getState()
    expect(state.activeTabId).toBe('browser:b2')
    expect(state.tabs.some((tab) => tab.id === 'browser:b1')).toBe(false)
  })

  it('renders nothing while a non-browser tab is shown', () => {
    act(() => { useSurfaceStore.getState().activateTab('terminal:t1') })
    mount()
    expect(rows()).toHaveLength(0)
  })
})
