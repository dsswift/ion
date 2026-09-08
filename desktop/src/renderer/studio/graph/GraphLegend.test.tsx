// @vitest-environment jsdom
/**
 * The legend is the key to the picture: a bound categorical colour must
 * show one swatch per value in the colour the reducer draws, a numeric
 * binding a ramp, and an unbound stage the structural defaults. A legend
 * that lists channel names without samples is what this pins against.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GraphLegend, MAX_LEGEND_VALUES } from './GraphLegend'
import { useGraphStore } from './graph-store'
import { buildChannelScales } from './channels/build-channel-scales'
import { darkColors } from '../../theme/palette-dark'
import type { GraphModel, GraphNode } from '../../../shared/graph-model-types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function doc(id: string, type: string, degree = 0): GraphNode {
  return { id, kind: 'document', label: id, frontMatter: { type }, sizeBytes: 0, modifiedMs: 0, degree, community: 0, centrality: 0, orphan: false }
}

function model(nodes: GraphNode[]): GraphModel {
  return { nodes, edges: [], dangling: [], anchorSuppressions: [], discoveredFields: ['type'], identityCollisions: [], centralityMethod: 'degree' }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useGraphStore.getState().dispose()
})

function mount(): void {
  act(() => {
    root.render(<GraphLegend />)
  })
  // The legend opens collapsed; every content assertion below reads the expanded panel.
  const chip = host.querySelector('[data-testid="graph-legend-chip"]') as HTMLButtonElement | null
  if (chip) act(() => chip.click())
}

function swatchBackgrounds(): string[] {
  return [...host.querySelectorAll('[data-testid="graph-legend"] span')].map((el) => (el as HTMLElement).style.background).filter((bg) => bg !== '')
}

describe('GraphLegend', () => {
  it('starts collapsed to a chip and expands on click, then collapses again', () => {
    useGraphStore.setState({ model: model([doc('a', 'note')]) })
    act(() => {
      root.render(<GraphLegend />)
    })
    const chip = host.querySelector('[data-testid="graph-legend-chip"]') as HTMLButtonElement
    expect(chip).not.toBeNull()
    expect(host.querySelector('[data-testid="graph-legend"]')).toBeNull()
    act(() => chip.click())
    expect(host.querySelector('[data-testid="graph-legend"]')).not.toBeNull()
    const close = host.querySelector('[aria-label="Collapse legend"]') as HTMLButtonElement
    act(() => close.click())
    expect(host.querySelector('[data-testid="graph-legend"]')).toBeNull()
    expect(host.querySelector('[data-testid="graph-legend-chip"]')).not.toBeNull()
  })

  it('with nothing bound, shows the structural kind defaults', () => {
    useGraphStore.setState({ model: model([doc('a', 'note')]) })
    mount()
    const text = host.textContent ?? ''
    expect(text).toContain('document')
    expect(text).toContain('topic')
    expect(text).toContain('section')
    expect(swatchBackgrounds().length).toBeGreaterThanOrEqual(4)
  })

  it('a categorical colour binding lists each value with its swatch and count, in reducer order', () => {
    const m = model([doc('a', 'note'), doc('b', 'note'), doc('c', 'adr')])
    const bindings = { ...useGraphStore.getState().bindings, nodeColor: { dimension: { source: 'frontMatter' as const, field: 'type' }, valueType: 'categorical' as const } }
    useGraphStore.setState({ model: m, bindings })
    mount()
    const text = host.textContent ?? ''
    expect(text).toContain('note · 2')
    expect(text).toContain('adr · 1')
    const scales = buildChannelScales(m, bindings, darkColors)
    const expected = [String(scales.nodeColor.apply('note')), String(scales.nodeColor.apply('adr'))]
    const drawn = swatchBackgrounds().map((bg) => bg.toLowerCase())
    for (const color of expected) expect(drawn.some((bg) => bg.includes(color.toLowerCase()) || bg.includes(hexToRgb(color)))).toBe(true)
  })

  it('folds a long domain past the row cap', () => {
    const nodes = Array.from({ length: MAX_LEGEND_VALUES + 3 }, (_, i) => doc(`n${i}`, `type${i}`))
    const bindings = { ...useGraphStore.getState().bindings, nodeColor: { dimension: { source: 'frontMatter' as const, field: 'type' }, valueType: 'categorical' as const } }
    useGraphStore.setState({ model: model(nodes), bindings })
    mount()
    expect(host.textContent).toContain('+3 more')
  })

  it('a numeric size binding shows a min-to-max ladder', () => {
    const m = model([doc('a', 'x', 1), doc('b', 'x', 9)])
    const bindings = { ...useGraphStore.getState().bindings, nodeSize: { dimension: { source: 'structural' as const, metric: 'degree' as const }, valueType: 'numeric' as const } }
    useGraphStore.setState({ model: m, bindings })
    mount()
    const text = host.textContent ?? ''
    expect(text).toContain('Size')
    expect(text).toContain('1')
    expect(text).toContain('9')
  })
})

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
