/**
 * Tests for saved-views.ts (child 08): captureView omits camera and never
 * writes a provisional or derived identity; applyView restores bindings,
 * filters, treatments, layers, forces and positions; a missing node
 * increments positionsMissing; source is stripped before write (tested at
 * the store level); a save failure leaves in-memory state unchanged (also
 * store level).
 */
import { describe, expect, it, vi } from 'vitest'
import { applyView, captureView, type SavedViewApplyActions, type SavedViewCaptureState } from './saved-views'
import { LAYOUT_FORCES_COMPACT, LAYOUT_FORCES_LOBES, type ChannelBindings, type GraphViewSavedView } from '../../../../shared/graph-view-types'

function bindings(): ChannelBindings {
  return {
    nodeColor: { dimension: null, valueType: 'categorical' },
    nodeShape: { dimension: null, valueType: 'categorical' },
    nodeSize: { dimension: null, valueType: 'categorical' },
    edgeColor: { dimension: null, valueType: 'categorical' },
    edgeThickness: { dimension: null, valueType: 'categorical' },
    edgeOpacity: { dimension: null, valueType: 'categorical' },
  }
}

function captureState(overrides: Partial<SavedViewCaptureState> = {}): SavedViewCaptureState {
  return {
    bindings: bindings(),
    filters: [],
    tagTreatment: 'off',
    clusterRendering: 'hull',
    showOrphans: false,
    showDangling: true,
    sectionNodes: true,
    promotedFields: new Set(['owner']),
    forces: LAYOUT_FORCES_COMPACT,
    positions: new Map([['a', { x: 1, y: 2 }]]),
    pinnedNodeIds: new Set(['a']),
    isDurableId: () => true,
    ...overrides,
  }
}

describe('captureView', () => {
  it('captures bindings, filters, treatments, layers, forces and positions, omitting camera', () => {
    const { view, droppedPositions, droppedPins } = captureView(captureState(), 'My View')
    expect(view.name).toBe('My View')
    expect(view.positions).toEqual({ a: { x: 1, y: 2 } })
    expect(view.pinned).toEqual(['a'])
    expect(view.showOrphans).toBe(false)
    expect(view.showDangling).toBe(true)
    expect(view.sectionNodes).toBe(true)
    expect(view.promotedFields).toEqual(['owner'])
    expect(view.forces).toEqual(LAYOUT_FORCES_COMPACT)
    expect('camera' in view).toBe(false)
    expect(droppedPositions).toBe(0)
    expect(droppedPins).toBe(0)
  })

  it('never writes a provisional or derived identity into positions or pins', () => {
    // A path-keyed document and a section are keyed for one read only; a
    // saved view that held them would point at keys the next read may not
    // produce (ADR-0036's rule that a provisional key is never persisted).
    const state = captureState({
      positions: new Map([
        ['durable', { x: 1, y: 2 }],
        ['/root/unstamped.md', { x: 3, y: 4 }],
        ['durable#Heading#1', { x: 5, y: 6 }],
      ]),
      pinnedNodeIds: new Set(['durable', '/root/unstamped.md']),
      isDurableId: (id) => id === 'durable',
    })
    const { view, droppedPositions, droppedPins } = captureView(state, 'V')
    expect(Object.keys(view.positions)).toEqual(['durable'])
    expect(view.pinned).toEqual(['durable'])
    expect(droppedPositions).toBe(2)
    expect(droppedPins).toBe(1)
  })
})

function actions(hasNode: (id: string) => boolean, configuredSectionNodes = false): SavedViewApplyActions & Record<string, ReturnType<typeof vi.fn> | unknown> {
  return {
    setBinding: vi.fn(),
    setFilters: vi.fn(),
    setTagTreatment: vi.fn(),
    setClusterRendering: vi.fn(),
    setShowOrphans: vi.fn(),
    setShowDangling: vi.fn(),
    setSectionNodes: vi.fn(),
    setPromotedFields: vi.fn(),
    setForces: vi.fn(),
    setNodePosition: vi.fn(),
    setPinnedNodes: vi.fn(),
    hasNode,
    configuredSectionNodes,
    defaultForces: LAYOUT_FORCES_LOBES,
  }
}

const BASE: GraphViewSavedView = { name: 'V', bindings: bindings(), filters: [], tagTreatment: 'off', clusterRendering: 'hull', positions: {} }

describe('applyView', () => {
  it('applies bindings, filters, treatments, layers, forces and positions through the action set', () => {
    const view: GraphViewSavedView = {
      ...BASE,
      showOrphans: false,
      showDangling: false,
      sectionNodes: true,
      promotedFields: ['owner', 'path'],
      forces: LAYOUT_FORCES_COMPACT,
      positions: { a: { x: 1, y: 2 } },
      pinned: ['a'],
    }
    const a = actions((id) => id === 'a')
    const result = applyView(view, a)
    expect(a.setFilters).toHaveBeenCalledWith([])
    expect(a.setTagTreatment).toHaveBeenCalledWith('off')
    expect(a.setClusterRendering).toHaveBeenCalledWith('hull')
    expect(a.setShowOrphans).toHaveBeenCalledWith(false)
    expect(a.setShowDangling).toHaveBeenCalledWith(false)
    expect(a.setSectionNodes).toHaveBeenCalledWith(true)
    expect(a.setPromotedFields).toHaveBeenCalledWith(['owner', 'path'])
    expect(a.setForces).toHaveBeenCalledWith(LAYOUT_FORCES_COMPACT)
    expect(a.setNodePosition).toHaveBeenCalledWith('a', 1, 2)
    expect(a.setPinnedNodes).toHaveBeenCalledWith(['a'])
    expect(result).toEqual({ positionsApplied: 1, positionsMissing: 0, pinsApplied: 1, pinsMissing: 0 })
  })

  it('pins for missing nodes are dropped and counted; a view without pins clears the set', () => {
    const withGhost = actions((id) => id === 'a')
    const result = applyView({ ...BASE, pinned: ['a', 'ghost'] }, withGhost)
    expect(withGhost.setPinnedNodes).toHaveBeenCalledWith(['a'])
    expect(result.pinsApplied).toBe(1)
    expect(result.pinsMissing).toBe(1)

    const legacy = actions(() => true, true)
    applyView(BASE, legacy)
    expect(legacy.setPinnedNodes).toHaveBeenCalledWith([])
    // A view saved before the toggles existed shows every orphan and every
    // stub, keeps the corpus's section setting, draws no anchor, and takes
    // the built-in force shape.
    expect(legacy.setShowOrphans).toHaveBeenCalledWith(true)
    expect(legacy.setShowDangling).toHaveBeenCalledWith(true)
    expect(legacy.setSectionNodes).toHaveBeenCalledWith(true)
    expect(legacy.setPromotedFields).toHaveBeenCalledWith([])
    expect(legacy.setForces).toHaveBeenCalledWith(LAYOUT_FORCES_LOBES)
  })

  it('a position for a node that no longer exists increments positionsMissing', () => {
    const result = applyView({ ...BASE, positions: { ghost: { x: 1, y: 2 } } }, actions(() => false))
    expect(result.positionsApplied).toBe(0)
    expect(result.positionsMissing).toBe(1)
  })
})
