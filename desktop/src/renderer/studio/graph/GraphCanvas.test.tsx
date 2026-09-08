// @vitest-environment jsdom
/**
 * GraphCanvas is the seam where every interaction behaviour meets sigma, and
 * two real defects lived there unseen by the type checker: a channel the
 * reducer never read, and a camera nothing ever moved. These tests drive the
 * component against a fake `Sigma` that records what it was told, so the
 * install-time contract is pinned without a WebGL context.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Graph from 'graphology'

/**
 * The fakes are built inside `vi.hoisted` because `vi.mock` factories are
 * hoisted above every import and must not close over module-level bindings
 * declared below them.
 */
const { FakeSigma, sigmaInstances } = vi.hoisted(() => {
  const sigmaInstances: FakeSigma[] = []

  class FakeCamera {
    ratio = 1
    listeners = new Map<string, Set<() => void>>()
    animate = vi.fn(async (state: { ratio?: number }) => {
      if (state.ratio !== undefined) this.ratio = state.ratio
    })
    animatedReset = vi.fn(async () => {
      this.ratio = 1
    })
    on(event: string, cb: () => void): void {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(cb)
    }
    off(event: string, cb: () => void): void {
      this.listeners.get(event)?.delete(cb)
    }
    getState(): { x: number; y: number; angle: number; ratio: number } {
      return { x: 0.5, y: 0.5, angle: 0, ratio: this.ratio }
    }
  }

  class FakeSigma {
    settings: Record<string, unknown>
    graph: Graph
    camera = new FakeCamera()
    captorHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
    captor = {
      on: (event: string, cb: (...args: unknown[]) => void): void => {
        if (!this.captorHandlers.has(event)) this.captorHandlers.set(event, new Set())
        this.captorHandlers.get(event)!.add(cb)
      },
      off: (event: string, cb: (...args: unknown[]) => void): void => {
        this.captorHandlers.get(event)?.delete(cb)
      },
    }
    handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    refresh = vi.fn()
    kill = vi.fn()
    resize = vi.fn()
    setGraph = vi.fn((g: Graph) => {
      this.graph = g
    })
    customBBox: unknown = null

    constructor(graph: Graph, _container: HTMLElement, settings: Record<string, unknown>) {
      this.graph = graph
      this.settings = { ...settings }
      sigmaInstances.push(this)
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set())
      this.handlers.get(event)!.add(cb)
    }
    off(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.get(event)?.delete(cb)
    }
    /** Test driver: fire a sigma event exactly as the renderer would. */
    emit(event: string, payload: unknown): void {
      for (const cb of this.handlers.get(event) ?? []) cb(payload)
    }
    emitCaptor(event: string): void {
      for (const cb of this.captorHandlers.get(event) ?? []) cb()
    }
    getGraph(): Graph {
      return this.graph
    }
    getCamera(): FakeCamera {
      return this.camera
    }
    getMouseCaptor(): typeof this.captor {
      return this.captor
    }
    setSetting(key: string, value: unknown): this {
      this.settings[key] = value
      return this
    }
    getDimensions(): { width: number; height: number } {
      return { width: 800, height: 600 }
    }
    getNodeDisplayData(key: string): { x: number; y: number } | undefined {
      if (!this.graph.hasNode(key)) return undefined
      return { x: this.graph.getNodeAttribute(key, 'x') / 1000, y: this.graph.getNodeAttribute(key, 'y') / 1000 }
    }
    viewportToFramedGraph(p: { x: number; y: number }): { x: number; y: number } {
      return { x: p.x / 600, y: p.y / 600 }
    }
    graphToViewport(p: { x: number; y: number }): { x: number; y: number } {
      return p
    }
    viewportToGraph(p: { x: number; y: number }): { x: number; y: number } {
      return p
    }
    getBBox(): unknown {
      return { x: [0, 1], y: [0, 1] }
    }
    getCustomBBox(): unknown {
      return this.customBBox
    }
    setCustomBBox(b: unknown): void {
      this.customBBox = b
    }
  }

  return { FakeSigma, sigmaInstances }
})
type FakeSigma = InstanceType<typeof FakeSigma>

vi.mock('sigma', () => ({ default: FakeSigma }))
vi.mock('sigma/rendering', () => ({ NodePointProgram: class {}, NodeProgram: class {}, EdgeRectangleProgram: class {}, EdgeArrowProgram: class {} }))
vi.mock('sigma/utils', () => ({ floatColor: () => 0 }))
vi.mock('@sigma/node-border', () => ({ NodeBorderProgram: class {}, createNodeBorderProgram: () => class {} }))
vi.mock('@sigma/edge-curve', () => ({ default: class {}, EdgeCurvedArrowProgram: class {} }))

import { GraphCanvas } from './GraphCanvas'
import { useGraphStore } from './graph-store'
import { _setSupervisorFactoryForTest, MAX_RUN_MS, type LayoutSupervisor } from './graph-layout'
import { MAX_CAMERA_RATIO, MIN_CAMERA_RATIO, FOCUS_RATIO } from './graph-camera'
import { parseColor } from './color-alpha'
import { MIN_EDGE_OPACITY } from './channels/scales'
import { darkColors } from '../../theme/palette-dark'
import type { GraphModel } from '../../../shared/graph-model-types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver

let host: HTMLDivElement
let root: Root

function model(): GraphModel {
  return {
    nodes: [
      { id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 1, community: 0, centrality: 0, orphan: false },
      { id: 'b', kind: 'document', label: 'B', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 1, community: 0, centrality: 0, orphan: false },
    ],
    edges: [{ id: 'a|b', source: 'a', target: 'b', directed: false, origin: 'wikilink', multiplicity: 3, crossRoot: false, dangling: false, recencyMs: 0 }],
    dangling: [],
    identityCollisions: [],
    discoveredFields: [],
    centralityMethod: 'degree',
  } as unknown as GraphModel
}

function graphOf(m: GraphModel): Graph {
  const g = new Graph({ multi: false, type: 'mixed' })
  g.addNode('a', { x: 100, y: 200, kind: 'document', label: 'A', degree: 1 })
  g.addNode('b', { x: 300, y: 400, kind: 'document', label: 'B', degree: 1 })
  g.addUndirectedEdgeWithKey('a|b', 'a', 'b', { directed: false, dangling: false, multiplicity: 3 })
  void m
  return g
}

function mount(graph: Graph): void {
  act(() => {
    root.render(<GraphCanvas graph={graph} />)
  })
}

/** A worker that never ticks: the tests below pin what the canvas asks of it, not the physics. */
const supervisorLog: { starts: number; stops: number; settings: Record<string, unknown> | null } = { starts: 0, stops: 0, settings: null }
_setSupervisorFactoryForTest((_graph, settings): LayoutSupervisor => {
  // The engine mutates this object in place on a force change; keeping the
  // reference is how a test sees the change reach the worker.
  supervisorLog.settings = settings
  return {
    start: () => {
      supervisorLog.starts++
    },
    stop: () => {
      supervisorLog.stops++
    },
    setIterations() {},
    kill: () => {},
  }
})

beforeEach(() => {
  supervisorLog.starts = 0
  supervisorLog.stops = 0
  supervisorLog.settings = null
  sigmaInstances.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const m = model()
  useGraphStore.setState({ model: m, graph: graphOf(m), visibleNodeIds: new Set(['a', 'b']), layoutState: 'settled', cameraRequest: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useGraphStore.getState().dispose()
})

describe('GraphCanvas', () => {
  it('mounts sigma with the zoom bounds', () => {
    mount(useGraphStore.getState().graph!)
    expect(sigmaInstances).toHaveLength(1)
    expect(sigmaInstances[0].settings.minCameraRatio).toBe(MIN_CAMERA_RATIO)
    expect(sigmaInstances[0].settings.maxCameraRatio).toBe(MAX_CAMERA_RATIO)
  })

  it('a focus request animates the camera to the node once the layout is settled', () => {
    mount(useGraphStore.getState().graph!)
    const sigma = sigmaInstances[0]
    sigma.camera.ratio = 2

    act(() => {
      useGraphStore.getState().requestCamera({ kind: 'focus', nodeId: 'b' })
    })

    expect(sigma.camera.animate).toHaveBeenCalledTimes(1)
    expect(sigma.camera.animate).toHaveBeenCalledWith({ x: 0.3, y: 0.4, ratio: FOCUS_RATIO }, { duration: expect.any(Number) })
  })

  it('a request made while the layout runs is applied when it settles, exactly once', () => {
    mount(useGraphStore.getState().graph!)
    const sigma = sigmaInstances[0]
    act(() => {
      useGraphStore.setState({ layoutState: 'running' })
      useGraphStore.getState().requestCamera({ kind: 'fit-all' })
    })
    expect(sigma.camera.animatedReset).not.toHaveBeenCalled()

    act(() => {
      useGraphStore.setState({ layoutState: 'settled' })
    })
    expect(sigma.camera.animatedReset).toHaveBeenCalledTimes(1)

    act(() => {
      useGraphStore.setState({ layoutState: 'idle' })
    })
    expect(sigma.camera.animatedReset).toHaveBeenCalledTimes(1)
  })

  it('installs an edge reducer that applies a bound opacity channel', () => {
    act(() => {
      useGraphStore.getState().setBinding('edgeOpacity', { source: 'edge', metric: 'multiplicity' })
    })
    mount(useGraphStore.getState().graph!)
    const reducer = sigmaInstances[0].settings.edgeReducer as (id: string, data: Record<string, unknown>) => { color: string }
    expect(typeof reducer).toBe('function')
    const parsed = parseColor(reducer('a|b', { directed: false, dangling: false }).color)!
    const base = parseColor(darkColors.graphEdgeDefault)!
    // A single-edge domain is constant, so the numeric scale sits at the midpoint.
    expect([parsed.r, parsed.g, parsed.b]).toEqual([base.r, base.g, base.b])
    expect(parsed.a).toBeGreaterThanOrEqual(MIN_EDGE_OPACITY)
    expect(parsed.a).not.toBeCloseTo(base.a, 3)
  })

  describe('drag drives the warm simulation', () => {
    function dragEvent(x: number, y: number): { x: number; y: number; preventSigmaDefault: () => void; original: { preventDefault: () => void; stopPropagation: () => void } } {
      return { x, y, preventSigmaDefault: vi.fn(), original: { preventDefault: vi.fn(), stopPropagation: vi.fn() } }
    }

    it('grabbing fixes the node and wakes the simulation; releasing frees it and keeps it running', () => {
      const graph = useGraphStore.getState().graph!
      mount(graph)
      const sigma = sigmaInstances[0]

      act(() => {
        sigma.emit('downNode', { node: 'a', event: dragEvent(100, 200) })
      })
      // A press alone is a click: nothing is fixed and nothing runs.
      expect(graph.getNodeAttribute('a', 'fixed')).toBeFalsy()
      expect(supervisorLog.starts).toBe(0)

      act(() => {
        sigma.emit('moveBody', { event: dragEvent(640, 480) })
      })
      expect(graph.getNodeAttribute('a', 'fixed')).toBe(true)
      expect(supervisorLog.starts).toBe(1)
      expect(useGraphStore.getState().layoutState).toBe('running')
      expect(graph.getNodeAttribute('a', 'x')).toBe(640)
      expect(graph.getNodeAttribute('a', 'y')).toBe(480)
      // Still one worker start: a move reheats, it does not restart.
      expect(supervisorLog.starts).toBe(1)

      act(() => {
        sigma.emitCaptor('mouseup')
      })
      // The drop is a local settle: the dropped node is held where the hand
      // left it until the settle cools (the engine releases it then).
      expect(graph.getNodeAttribute('a', 'fixed')).toBe(true)
      expect(useGraphStore.getState().positions.get('a')).toEqual({ x: 640, y: 480 })
      // The drop never restarts the worker: the released flag reaches it on
      // the next write-back, and the run keeps its momentum.
      expect(supervisorLog.stops).toBe(0)
      expect(supervisorLog.starts).toBe(1)
    })

    it('a press that moves less than the dead zone is a click and never wakes the simulation', () => {
      const graph = useGraphStore.getState().graph!
      mount(graph)
      const sigma = sigmaInstances[0]
      act(() => {
        sigma.emit('downNode', { node: 'a', event: dragEvent(100, 200) })
        sigma.emit('moveBody', { event: dragEvent(102, 201) })
        sigma.emitCaptor('mouseup')
      })
      expect(supervisorLog.starts).toBe(0)
      expect(graph.getNodeAttribute('a', 'fixed')).toBeFalsy()
      expect(useGraphStore.getState().layoutState).not.toBe('running')
    })

    it('a pinned node stays fixed after release', () => {
      const graph = useGraphStore.getState().graph!
      useGraphStore.setState({ pinnedNodeIds: new Set(['a']) })
      mount(graph)
      const sigma = sigmaInstances[0]
      act(() => {
        sigma.emit('downNode', { node: 'a', event: dragEvent(100, 200) })
        sigma.emit('moveBody', { event: dragEvent(10, 20) })
        sigma.emitCaptor('mouseup')
      })
      expect(graph.getNodeAttribute('a', 'fixed')).toBe(true)
    })
  })

  describe('click navigation', () => {
    const click = (extra: Partial<MouseEvent> = {}): { original: Partial<MouseEvent>; preventSigmaDefault: () => void } => ({ original: { metaKey: false, ctrlKey: false, shiftKey: false, ...extra }, preventSigmaDefault: vi.fn() })

    it('a plain click selects and centres the camera on the node at the current zoom', () => {
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      sigma.camera.ratio = 2
      act(() => {
        sigma.emit('clickNode', { node: 'b', event: click() })
      })
      expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['b'])
      expect(sigma.camera.animate).toHaveBeenCalledWith({ x: 0.3, y: 0.4, ratio: 2 }, { duration: expect.any(Number) })
    })

    it('a Shift+click extends the selection without moving the camera', () => {
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      act(() => {
        sigma.emit('clickNode', { node: 'a', event: click() })
        sigma.emit('clickNode', { node: 'b', event: click({ shiftKey: true }) })
      })
      expect([...useGraphStore.getState().selectedNodeIds].sort()).toEqual(['a', 'b'])
      expect(sigma.camera.animate).toHaveBeenCalledTimes(1)
    })

    it('a double-click drills into the node and suppresses sigma\'s own zoom', () => {
      useGraphStore.setState({ scope: { mode: 'corpus', anchorId: null, depth: 1 }, config: { neighborhoodDepth: 1 } as never })
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      const event = click()
      act(() => {
        sigma.emit('doubleClickNode', { node: 'a', event })
      })
      expect(event.preventSigmaDefault).toHaveBeenCalled()
      expect(useGraphStore.getState().scope).toMatchObject({ mode: 'neighborhood', anchorId: 'a' })
    })

    it('Enter opens the newest selected node; Escape clears the selection', () => {
      const requestOpenFile = vi.fn()
      useGraphStore.setState({ requestOpenFile })
      mount(useGraphStore.getState().graph!)
      act(() => {
        useGraphStore.getState().selectNode('b')
      })
      const container = host.querySelector('div[tabindex="0"]') as HTMLDivElement
      act(() => {
        container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(requestOpenFile).toHaveBeenCalledWith('b')
      act(() => {
        container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(useGraphStore.getState().selectedNodeIds.size).toBe(0)
    })
  })

  describe('hover, context menu, keys, and confined runs', () => {
    const click = (extra: Partial<MouseEvent> = {}): { original: Partial<MouseEvent> & { preventDefault: () => void }; preventSigmaDefault: () => void; x: number; y: number } => ({ original: { metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), ...extra }, preventSigmaDefault: vi.fn(), x: 40, y: 50 })

    it('entering a node lights its neighbourhood at once and leaving clears it; Quick Peek still waits', () => {
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      act(() => {
        sigma.emit('enterNode', { node: 'a' })
      })
      expect(useGraphStore.getState().hoverNodeId).toBe('a')
      expect([...useGraphStore.getState().hoverEmphasisNodeIds].sort()).toEqual(['a', 'b'])
      expect(useGraphStore.getState().quickPeekNodeId).toBeNull()
      act(() => {
        sigma.emit('leaveNode', { node: 'a' })
      })
      expect(useGraphStore.getState().hoverNodeId).toBeNull()
      expect(useGraphStore.getState().hoverEmphasisNodeIds.size).toBe(0)
    })

    it('hovering an edge peeks it', () => {
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      act(() => {
        sigma.emit('enterEdge', { edge: 'a|b' })
      })
      expect(useGraphStore.getState().quickPeekEdgeId).toBe('a|b')
      act(() => {
        sigma.emit('leaveEdge', { edge: 'a|b' })
      })
      expect(useGraphStore.getState().quickPeekEdgeId).toBeNull()
    })

    it('a right-click opens the context menu on the node, or on the stage, and a click closes it', () => {
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      const event = click()
      act(() => {
        sigma.emit('rightClickNode', { node: 'b', event })
      })
      expect(event.preventSigmaDefault).toHaveBeenCalled()
      expect(useGraphStore.getState().contextMenu).toEqual({ nodeId: 'b', at: { x: 40, y: 50 } })
      act(() => {
        sigma.emit('rightClickStage', { event: click() })
      })
      expect(useGraphStore.getState().contextMenu?.nodeId).toBeNull()
      act(() => {
        sigma.emit('clickStage', { event: click() })
      })
      expect(useGraphStore.getState().contextMenu).toBeNull()
    })

    it('Shift+double-click collapses an expansion instead of drilling', () => {
      useGraphStore.setState({ scope: { mode: 'neighborhood', anchorId: 'a', depth: 1, expandedIds: new Set(['b']) } })
      mount(useGraphStore.getState().graph!)
      const sigma = sigmaInstances[0]
      act(() => {
        sigma.emit('doubleClickNode', { node: 'b', event: click({ shiftKey: true }) })
      })
      expect(useGraphStore.getState().scope.expandedIds?.has('b')).toBe(false)
    })

    it('F fits, P pins, H hides the newest selected node', () => {
      mount(useGraphStore.getState().graph!)
      const container = host.querySelector('div[tabindex="0"]') as HTMLDivElement
      const press = (key: string): void => {
        act(() => {
          container.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        })
      }
      act(() => {
        useGraphStore.getState().selectNode('b')
      })
      const before = useGraphStore.getState().cameraRequest?.seq ?? 0
      press('f')
      expect(useGraphStore.getState().cameraRequest?.seq).toBeGreaterThan(before)
      expect(useGraphStore.getState().cameraRequest?.kind).toBe('fit-all')
      press('p')
      expect(useGraphStore.getState().pinnedNodeIds.has('b')).toBe(true)
      press('h')
      expect(useGraphStore.getState().hiddenNodeIds.has('b')).toBe(true)
      expect(useGraphStore.getState().selectedNodeIds.has('b')).toBe(false)
    })

    /**
     * jsdom lays nothing out, so the stage container reports a zero rect and
     * the canvas would defer the layout until the container has a size —
     * exactly what it does for a hidden surface. Give it real geometry.
     */
    const sized = (): void => {
      const rect = { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    }

    it('a confined layout request runs the engine over the free set without reseeding', () => {
      sized()
      const graph = useGraphStore.getState().graph!
      mount(graph)
      const xBefore = graph.getNodeAttribute('a', 'x')
      act(() => {
        useGraphStore.setState({ layoutState: 'requested', layoutFree: new Set(['b']) })
      })
      expect(supervisorLog.starts).toBe(1)
      expect(useGraphStore.getState().layoutState).toBe('running')
      expect(useGraphStore.getState().layoutFree).toBeNull()
      // Confined: a stays fixed and unseeded, b is free.
      expect(graph.getNodeAttribute('a', 'x')).toBe(xBefore)
      expect(graph.getNodeAttribute('a', 'fixed')).toBe(true)
      expect(graph.getNodeAttribute('b', 'fixed')).toBe(false)
    })

    it('a force change reaches the engine and starts a run', () => {
      sized()
      vi.useFakeTimers()
      try {
        const graph = useGraphStore.getState().graph!
        mount(graph)
        act(() => {
          useGraphStore.setState({ layoutState: 'requested', layoutFree: null })
        })
        expect(supervisorLog.starts).toBe(1)
        // The fake worker never ticks, so the first run cools only when its
        // budget runs out. Let it, so the engine is genuinely settled.
        act(() => {
          vi.advanceTimersByTime(MAX_RUN_MS + 1)
        })
        expect(useGraphStore.getState().layoutState).toBe('settled')
        act(() => {
          useGraphStore.getState().setForces({ gravity: 0.5, scalingRatio: 4, edgeWeightInfluence: 1, damping: 1 })
        })
        expect(supervisorLog.settings?.gravity).toBe(0.5)
        expect(supervisorLog.settings?.scalingRatio).toBe(4)
        expect(supervisorLog.starts).toBe(2)
        expect(useGraphStore.getState().layoutState).toBe('running')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
