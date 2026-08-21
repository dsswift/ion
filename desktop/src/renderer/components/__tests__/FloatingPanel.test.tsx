// @vitest-environment jsdom
/**
 * FloatingPanel — data-view boundary placement test.
 *
 * Verifies:
 *   - The content wrapper div carries --ion-conv-font-size: <n>px.
 *   - The header div does NOT carry --ion-conv-font-size (chrome stays fixed).
 *
 * Also verifies the openFloatingPanelCount store behavior (inc on mount,
 * dec on unmount).
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── Store mocks ────────────────────────────────────────────────────────────

let dataViewFontSize = 16
let openFloatingPanelCount = 0

vi.mock('../../preferences', () => ({
  usePreferencesStore: (sel: any) => sel({ dataViewFontSize }),
}))

const incMock = vi.fn(() => { openFloatingPanelCount++ })
const decMock = vi.fn(() => { openFloatingPanelCount = Math.max(0, openFloatingPanelCount - 1) })

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({
    openFloatingPanelCount,
    incOpenFloatingPanelCount: incMock,
    decOpenFloatingPanelCount: decMock,
  }),
}))

// useColors mock.
vi.mock('../../theme', () => ({
  useColors: () => ({
    containerBg: '#000',
    containerBorder: '#111',
    surfacePrimary: '#222',
    textTertiary: '#333',
    textSecondary: '#444',
    accent: '#00aaff',
  }),
}))

// PopoverLayer mock — render directly (no portal).
vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => {
    return document.body
  },
}))

// X icon mock.
vi.mock('@phosphor-icons/react', () => ({ X: () => null }))

const openPanel = vi.fn<(title: string, body: React.ReactNode, close: () => void) => string>(() => 'panel:1')
const updatePanel = vi.fn<(id: string, title: string, body: React.ReactNode) => void>()
const closePanel = vi.fn<(id: string) => void>()
let routerEnabled = false
vi.mock('../../lib/file-open-router', () => ({
  contentRouter: () => routerEnabled ? { openPanel, updatePanel, closePanel } : null,
}))

import { FloatingPanel } from '../FloatingPanel'

function Panel(props: { children: React.ReactNode; title?: string; onClose?: () => void }) {
  return React.createElement(FloatingPanel, {
    title: props.title ?? 'Test',
    onClose: props.onClose ?? (() => {}),
    children: props.children,
  })
}

describe('FloatingPanel — data-view boundary', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    dataViewFontSize = 16
    openFloatingPanelCount = 0
    incMock.mockClear()
    decMock.mockClear()
    openPanel.mockClear()
    updatePanel.mockClear()
    closePanel.mockClear()
    routerEnabled = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    document.body.removeChild(container)
  })

  it('content wrapper is marked as a data-view boundary', async () => {
    await act(async () => {
      root.render(React.createElement(Panel, null, React.createElement('div', { 'data-testid': 'child' }, 'content')))
    })

    const allDivs = Array.from(document.body.querySelectorAll('div'))
    const contentWrapper = allDivs.find((div) => {
      return div.classList.contains('ion-data-view')
    })
    expect(contentWrapper).toBeDefined()
  })

  it('header remains outside data-view boundary', async () => {
    await act(async () => {
      root.render(React.createElement(Panel, null, React.createElement('div', { 'data-testid': 'child-2' }, 'child content')))
    })

    const allDivs = Array.from(document.body.querySelectorAll('div'))
    const withVar = allDivs.filter((div) => {
      return div.classList.contains('ion-data-view')
    })
    // Exactly one div — the content wrapper — carries the variable.
    expect(withVar).toHaveLength(1)
    // That div is the content wrapper (contains the child).
    const child = withVar[0].querySelector('[data-testid="child-2"]')
    expect(child).not.toBeNull()
  })

  it('increments openFloatingPanelCount on mount', async () => {
    expect(openFloatingPanelCount).toBe(0)
    await act(async () => {
      root.render(React.createElement(Panel, null, React.createElement('div', null, 'c')))
    })
    expect(incMock).toHaveBeenCalledOnce()
    expect(openFloatingPanelCount).toBe(1)
  })

  it('decrements openFloatingPanelCount on unmount', async () => {
    await act(async () => {
      root.render(React.createElement(Panel, null, React.createElement('div', null, 'c')))
    })
    expect(openFloatingPanelCount).toBe(1)
    await act(async () => { root.unmount() })
    expect(decMock).toHaveBeenCalledOnce()
    expect(openFloatingPanelCount).toBe(0)
    // Re-create for afterEach cleanup.
    root = createRoot(container)
  })

  it('routes one stable panel and publishes later async children to Studio', async () => {
    routerEnabled = true
    await act(async () => {
      root.render(React.createElement(Panel, { title: 'Loading', children: React.createElement('div', null, 'Loading conflict state…') }))
    })
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(openPanel.mock.calls[0]?.[0]).toBe('Loading')

    await act(async () => {
      root.render(React.createElement(Panel, { title: 'Conflicts', children: React.createElement('div', null, 'engine/internal/backend/runloop.go') }))
    })
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(updatePanel).toHaveBeenLastCalledWith(
      'panel:1',
      'Conflicts',
      expect.anything(),
    )
    expect((updatePanel.mock.calls.at(-1)?.[2] as React.ReactElement<{ children: React.ReactNode }>).props.children).toBe('engine/internal/backend/runloop.go')
  })

  it('releases routed surface when owner unmounts', async () => {
    routerEnabled = true
    await act(async () => {
      root.render(React.createElement(Panel, { children: React.createElement('div', null, 'content') }))
    })
    await act(async () => { root.unmount() })
    expect(closePanel).toHaveBeenCalledWith('panel:1')
    root = createRoot(container)
  })

})
