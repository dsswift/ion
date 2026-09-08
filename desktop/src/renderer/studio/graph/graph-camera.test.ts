/**
 * Pins the camera math and the request → animate resolution, driven through
 * a fake sigma so no WebGL context is needed.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyCameraRequest,
  boundsOf,
  cameraStateForBounds,
  cameraStateForFocus,
  clampRatio,
  FOCUS_RATIO,
  MAX_CAMERA_RATIO,
  MIN_CAMERA_RATIO,
  unitVisibleExtent,
  type CameraSigma,
} from './graph-camera'

describe('boundsOf', () => {
  it('returns the bounding box and ignores non-finite points', () => {
    expect(boundsOf([{ x: 0.2, y: 0.9 }, { x: 0.7, y: 0.1 }, { x: Number.NaN, y: 0 }])).toEqual({ minX: 0.2, minY: 0.1, maxX: 0.7, maxY: 0.9 })
  })
  it('is null for no points', () => {
    expect(boundsOf([])).toBeNull()
  })
})

describe('cameraStateForBounds', () => {
  it('centres on the box and picks the larger axis ratio, padded', () => {
    // At unit ratio the stage shows 1.0 x 0.5 of framed space; a 0.4 x 0.4
    // box is limited by height: 0.4/0.5 = 0.8, padded 1.2 → 0.96.
    const target = cameraStateForBounds({ minX: 0.1, minY: 0.2, maxX: 0.5, maxY: 0.6 }, { width: 1, height: 0.5 }, { padding: 1.2 })
    expect(target.x).toBeCloseTo(0.3)
    expect(target.y).toBeCloseTo(0.4)
    expect(target.ratio).toBeCloseTo(0.96)
  })

  it('a single point resolves to the focus ratio rather than zero', () => {
    const target = cameraStateForBounds({ minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5 }, { width: 1, height: 1 })
    expect(target.ratio).toBe(FOCUS_RATIO)
  })

  it('clamps to the zoom bounds', () => {
    const huge = cameraStateForBounds({ minX: -50, minY: -50, maxX: 50, maxY: 50 }, { width: 1, height: 1 })
    expect(huge.ratio).toBe(MAX_CAMERA_RATIO)
    expect(clampRatio(0)).toBe(MIN_CAMERA_RATIO)
  })
})

describe('cameraStateForFocus', () => {
  it('zooms in to the focus ratio from a zoomed-out camera', () => {
    expect(cameraStateForFocus({ x: 0.2, y: 0.3 }, 3)).toEqual({ x: 0.2, y: 0.3, ratio: FOCUS_RATIO })
  })
  it('keeps a camera that is already closer', () => {
    expect(cameraStateForFocus({ x: 0.2, y: 0.3 }, 0.1).ratio).toBe(0.1)
  })
})

function fakeSigma(nodes: Record<string, { x: number; y: number }>, ratio = 2): CameraSigma & { animate: ReturnType<typeof vi.fn>; animatedReset: ReturnType<typeof vi.fn> } {
  const animate = vi.fn(async () => {})
  const animatedReset = vi.fn(async () => {})
  return {
    animate,
    animatedReset,
    getCamera: () => ({ ratio, animate, animatedReset }),
    getDimensions: () => ({ width: 800, height: 400 }),
    getNodeDisplayData: (key) => nodes[key],
    // A unit camera on an 800x400 stage shows framed [0,2] x [0,1] in this fake.
    viewportToFramedGraph: (p) => ({ x: p.x / 400, y: p.y / 400 }),
    graphToViewport: (p) => ({ x: p.x * 4, y: p.y * 4 }),
  }
}

describe('applyCameraRequest', () => {
  it('reports settled after the animation lands, and at once when there is nothing to aim at', async () => {
    const sigma = fakeSigma({})
    const settled = vi.fn()
    applyCameraRequest(sigma, { seq: 1, kind: 'fit-all' }, settled)
    // The animation promise has not resolved yet at this point.
    expect(settled).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledTimes(1)

    const missing = vi.fn()
    applyCameraRequest(sigma, { seq: 2, kind: 'focus', nodeId: 'absent' }, missing)
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('fit-all resets the camera', () => {
    const sigma = fakeSigma({})
    const target = applyCameraRequest(sigma, { seq: 1, kind: 'fit-all' })
    expect(sigma.animatedReset).toHaveBeenCalledTimes(1)
    expect(target).toEqual({ x: 0.5, y: 0.5, ratio: 1 })
  })

  it('focus animates to the node at the focus ratio', () => {
    const sigma = fakeSigma({ a: { x: 0.25, y: 0.75 } })
    const target = applyCameraRequest(sigma, { seq: 2, kind: 'focus', nodeId: 'a' })
    expect(sigma.animate).toHaveBeenCalledWith({ x: 0.25, y: 0.75, ratio: FOCUS_RATIO }, { duration: expect.any(Number) })
    expect(target?.ratio).toBe(FOCUS_RATIO)
  })

  it('focus on an unknown node does nothing and returns null', () => {
    const sigma = fakeSigma({})
    expect(applyCameraRequest(sigma, { seq: 3, kind: 'focus', nodeId: 'ghost' })).toBeNull()
    expect(sigma.animate).not.toHaveBeenCalled()
  })

  it('fit-nodes centres on the subset and zooms to fit it', () => {
    const sigma = fakeSigma({ a: { x: 0.2, y: 0.2 }, b: { x: 0.6, y: 0.4 }, hidden: { x: 5, y: 5 } })
    const target = applyCameraRequest(sigma, { seq: 4, kind: 'fit-nodes', nodeIds: ['a', 'b', 'missing'] })
    expect(unitVisibleExtent(sigma)).toEqual({ width: 2, height: 1 })
    expect(target?.x).toBeCloseTo(0.4)
    expect(target?.y).toBeCloseTo(0.3)
    // width 0.4 / 2 = 0.2, height 0.2 / 1 = 0.2, padded 1.2 → 0.24
    expect(target?.ratio).toBeCloseTo(0.24)
    expect(sigma.animate).toHaveBeenCalledTimes(1)
  })

  it('center-node centres on the node and keeps the current ratio', () => {
    const sigma = fakeSigma({ a: { x: 0.25, y: 0.75 } }, 2.5)
    const target = applyCameraRequest(sigma, { seq: 6, kind: 'center-node', nodeId: 'a' })
    expect(target).toEqual({ x: 0.25, y: 0.75, ratio: 2.5 })
    expect(applyCameraRequest(sigma, { seq: 7, kind: 'center-node', nodeId: 'ghost' })).toBeNull()
  })

  it('center keeps the current ratio and converts graph coordinates through sigma', () => {
    const sigma = fakeSigma({}, 1.5)
    const target = applyCameraRequest(sigma, { seq: 5, kind: 'center', x: 100, y: 50 })
    // graph (100,50) → viewport (400,200) → framed (1, 0.5)
    expect(target).toEqual({ x: 1, y: 0.5, ratio: 1.5 })
  })
})
