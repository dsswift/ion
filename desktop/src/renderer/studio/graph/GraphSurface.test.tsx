// @vitest-environment jsdom
/**
 * The toolbar row floats over the stage with `left: 8, right: 8`, so its own
 * box stretches almost the full stage width to let its buttons wrap — well
 * past its last visible control. That box renders after `GraphInspector` in
 * the same stacking context, so without `pointer-events: none` it painted
 * over the inspector's top-right corner and silently ate clicks meant for
 * the Pin/Open buttons underneath (the operator never saw a broken link;
 * the buttons just did nothing).
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'

vi.mock('./GraphCanvas', () => ({ GraphCanvas: () => null }))
vi.mock('./GraphBindingPanel', () => ({ GraphBindingPanel: () => null }))
vi.mock('./GraphLegend', () => ({ GraphLegend: () => null }))
vi.mock('./GraphInspector', () => ({ GraphInspector: () => null }))
vi.mock('./GraphQuickPeek', () => ({ GraphQuickPeek: () => null }))
vi.mock('./GraphIssueBadges', () => ({ GraphIssueBadges: () => null }))
vi.mock('./minimap/GraphMinimap', () => ({ GraphMinimap: () => null }))
vi.mock('./filter/GraphFilterPanel', () => ({ GraphFilterPanel: () => null }))
vi.mock('./views/GraphViewsMenu', () => ({ GraphViewsMenu: () => null }))

import { GraphSurface } from './GraphSurface'
import { useGraphStore } from './graph-store'
import { useSessionStore } from '../../stores/sessionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSessionStore.setState({
    activeTabId: 'ion',
    tabs: [{ id: 'ion', workingDirectory: '/worktrees/ion', historicalSessionIds: [], bashResults: [], label: 'ion', status: 'idle' }] as never,
  })
  useGraphStore.setState({ available: true, graph: new Graph(), projectPath: '/worktrees/ion' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function toolbarButton(label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!el) throw new Error(`no toolbar button labelled ${label}`)
  return el
}

describe('GraphSurface toolbar row', () => {
  it('lets clicks fall through its own empty space instead of blocking whatever is under it', () => {
    act(() => {
      root.render(<GraphSurface active />)
    })
    const row = toolbarButton('Bindings').parentElement
    expect(row?.style.pointerEvents).toBe('none')
  })

  it('keeps every real toolbar control clickable despite the row disabling pointer events', () => {
    act(() => {
      root.render(<GraphSurface active />)
    })
    expect(toolbarButton('Bindings').style.pointerEvents).toBe('auto')
    // Reset layout is the way back from an arrangement the operator has
    // pushed out of shape; a control they cannot click is no way back.
    expect(toolbarButton('Reset layout').style.pointerEvents).toBe('auto')
    expect(toolbarButton('Filters').style.pointerEvents).toBe('auto')
    expect(toolbarButton('Fit').style.pointerEvents).toBe('auto')

    const searchInput = host.querySelector('input[placeholder="Search the corpus…"]')
    const searchRoot = searchInput?.parentElement as HTMLElement | null
    expect(searchRoot?.style.pointerEvents).toBe('auto')
  })

  it('uses Electron-safe shared tooltips for scope help', () => {
    useGraphStore.setState({ scope: { mode: 'neighborhood', anchorId: 'node', depth: 1 } })
    act(() => {
      root.render(<GraphSurface active />)
    })
    expect(toolbarButton('Both').getAttribute('title')).toBeNull()
    expect(toolbarButton('Out').getAttribute('title')).toBeNull()
    expect(host.querySelector('[title="Hops from the anchor"]')).not.toBeNull()
  })
})
