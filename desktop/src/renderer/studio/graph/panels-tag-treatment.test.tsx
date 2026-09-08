// @vitest-environment jsdom
/**
 * The two panels that surface the dimension catalog must each honour the tag
 * treatment. Both call `buildDimensionCatalog` themselves, so a wiring miss
 * in either one is invisible to the catalog's own unit test: 'off' would go
 * on offering the tag field and read identically to 'filter' in the only
 * place an operator can actually see the difference.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GraphFilterPanel } from './filter/GraphFilterPanel'
import { GraphBindingPanel } from './GraphBindingPanel'
import { useGraphStore } from './graph-store'
import { GRAPH_VIEW_DEFAULTS, type GraphViewConfig, type TagTreatment } from '../../../shared/graph-view-types'
import type { GraphModel } from '../../../shared/graph-model-types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function config(): GraphViewConfig {
  return {
    corpusRoots: [{ path: '/root' }],
    identityField: GRAPH_VIEW_DEFAULTS.identityField,
    labelField: GRAPH_VIEW_DEFAULTS.labelField,
    tagField: GRAPH_VIEW_DEFAULTS.tagField,
    groupFields: [],
    edgeFields: GRAPH_VIEW_DEFAULTS.edgeFields,
    hoverFields: [],
    curatedFields: [],
    promotedFields: [],
    savedViews: [],
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: GRAPH_VIEW_DEFAULTS.sectionNodes,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
  }
}

/** A model whose discovered fields include the tag field and one ordinary field. */
function model(): GraphModel {
  return {
    nodes: [
      { id: 'a', kind: 'document', label: 'A', frontMatter: { tags: ['topic/security'], type: 'note' }, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
    ],
    edges: [],
    dangling: [],
    discoveredFields: ['tags', 'type'],
    identityCollisions: [],
    centralityMethod: 'degree',
  } as unknown as GraphModel
}

function mount(element: React.ReactElement): void {
  act(() => {
    root.render(element)
  })
}

/** Text of every <option> currently rendered. */
function optionTexts(): string[] {
  return [...host.querySelectorAll('option')].map((o) => o.textContent ?? '')
}

function setTreatment(treatment: TagTreatment): void {
  act(() => {
    useGraphStore.setState({ tagTreatment: treatment })
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useGraphStore.setState({ model: model(), config: config(), tagTreatment: 'filter' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('GraphFilterPanel honours the tag treatment', () => {
  // The panel only renders a dimension picker per existing rule, so a rule
  // has to exist before there is anything to assert against.
  function withOneRule(): void {
    act(() => {
      useGraphStore.setState({ filters: [{ dimension: { source: 'frontMatter', field: 'type' }, mode: 'include', values: [] }] })
    })
  }

  it("offers the tag field under 'filter'", () => {
    setTreatment('filter')
    withOneRule()
    mount(<GraphFilterPanel />)
    expect(optionTexts()).toContain('tags')
  })

  it("withholds the tag field under 'off', keeping other fields", () => {
    setTreatment('off')
    withOneRule()
    mount(<GraphFilterPanel />)
    expect(optionTexts()).not.toContain('tags')
    expect(optionTexts()).toContain('type')
  })

  it('a rule\'s dimension is selectable, not fixed at whatever it was created with', () => {
    setTreatment('filter')
    withOneRule()
    mount(<GraphFilterPanel />)
    // Structural, mechanical, and front-matter families all reachable.
    const texts = optionTexts()
    expect(texts).toContain('Degree')
    expect(texts).toContain('Orphan')
    expect(texts).toContain('type')
  })

  it('a rule on a dimension absent from the catalog still renders selectably', () => {
    setTreatment('off')
    act(() => {
      // 'tags' is withheld under 'off', so this rule's dimension is not in
      // the catalog; it must not silently adopt another rule's field.
      useGraphStore.setState({ filters: [{ dimension: { source: 'frontMatter', field: 'tags' }, mode: 'include', values: ['topic/security'] }] })
    })
    mount(<GraphFilterPanel />)
    expect(optionTexts()).toContain('(unavailable)')
  })
})

describe('GraphBindingPanel honours the tag treatment', () => {
  it("offers the tag field under 'filter'", () => {
    setTreatment('filter')
    mount(<GraphBindingPanel />)
    expect(optionTexts()).toContain('tags')
  })

  it("withholds the tag field under 'off', keeping other fields", () => {
    setTreatment('off')
    mount(<GraphBindingPanel />)
    expect(optionTexts()).not.toContain('tags')
    expect(optionTexts()).toContain('type')
  })
})
