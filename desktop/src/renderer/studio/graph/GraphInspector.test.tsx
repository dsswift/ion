// @vitest-environment jsdom
/**
 * Pins what the inspector actually shows. It reported metrics only — no
 * links at all — which is the thing an operator opens it for: the panel
 * exists to answer "what is this connected to".
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphInspector } from './GraphInspector'
import { useGraphStore } from './graph-store'
import type { GraphModel, GraphNode, GraphEdge } from '../../../shared/graph-model-types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function mount(): void {
  act(() => {
    root.render(<GraphInspector />)
  })
}

/** Every rendered element whose own text is exactly `text`. */
function findByText(text: string): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>('*')].find((el) => el.textContent === text && el.children.length === 0) ?? null
}

function click(text: string): void {
  const el = findByText(text)
  if (!el) throw new Error(`no element with text ${text}`)
  const target = el.closest('button') ?? el
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return { id, kind: 'document', label: id.toUpperCase(), frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: false, ...overrides }
}

function edge(source: string, target: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${source}|${target}`, source, target, directed: true, origin: 'wikilink', multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0, ...overrides }
}

function model(): GraphModel {
  return {
    nodes: [node('a', { path: '/root/a.md', degree: 2 }), node('b'), node('c'), node('gone', { kind: 'dangling', label: 'gone' })],
    edges: [edge('a', 'b'), edge('a', 'gone', { dangling: true }), edge('c', 'a', { origin: 'markdown-link' })],
    dangling: [],
    identityCollisions: [],
    discoveredFields: [],
    centralityMethod: 'betweenness',
  } as unknown as GraphModel
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useGraphStore.setState({ model: model(), selectedNodeIds: new Set(['a']), requestOpenFile: vi.fn() })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('GraphInspector', () => {
  it('lists outgoing and incoming links with their counts', () => {
    mount()
    expect(findByText('Links out (2)')).toBeTruthy()
    expect(findByText('Links in (1)')).toBeTruthy()
    expect(findByText('B')).toBeTruthy()
    expect(findByText('C')).toBeTruthy()
  })

  it('marks a broken outbound link instead of hiding it', () => {
    mount()
    expect(findByText('gone (broken)')).toBeTruthy()
  })

  it('selects the neighbour when its row is clicked', () => {
    mount()
    click('B')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['b'])
  })

  it('offers to open a node that has a file', () => {
    mount()
    click('Open')
    expect(useGraphStore.getState().requestOpenFile).toHaveBeenCalledWith('a')
  })

  it('offers no open action for a node with no file', () => {
    useGraphStore.setState({ selectedNodeIds: new Set(['b']) })
    mount()
    expect(findByText('Open')).toBeNull()
  })

  it('renders nothing when there is no selection', () => {
    useGraphStore.setState({ selectedNodeIds: new Set() })
    mount()
    expect(host.firstChild).toBeNull()
  })

  it('pins and unpins the node from the header', () => {
    mount()
    expect(findByText('Pin')).toBeTruthy()
    click('Pin')
    expect(useGraphStore.getState().pinnedNodeIds.has('a')).toBe(true)
    expect(findByText('Unpin')).toBeTruthy()
    click('Unpin')
    expect(useGraphStore.getState().pinnedNodeIds.has('a')).toBe(false)
  })

  it('a multi-selection leads with the count and lists every selected node', () => {
    useGraphStore.setState({ selectedNodeIds: new Set(['a', 'c']) })
    mount()
    expect(findByText('2 selected')).toBeTruthy()
    // Detail is for the newest addition, c.
    expect(findByText('Links out (1)')).toBeTruthy()
    // Narrowing: clicking the A row in the selection list selects a alone.
    click('A')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['a'])
  })
})
