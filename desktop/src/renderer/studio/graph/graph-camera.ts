/**
 * Camera commands — the only place Graph View WRITES the camera.
 *
 * Sigma keeps the camera in its "framed graph" space: the graph's bounding
 * box normalized so that, at `ratio: 1` centred on `(0.5, 0.5)`, the whole
 * graph fits the stage. Every command below resolves to a target in that
 * space and animates there. The pure half (`cameraStateForBounds`,
 * `cameraStateForFocus`) is exercised directly by tests; the sigma-facing
 * half (`applyCameraRequest`) is typed against the narrow `CameraSigma`
 * surface so a test can drive it with a fake instead of a WebGL context.
 *
 * Fitting a node subset needs to know how much framed space the stage shows
 * at unit ratio, and that depends on sigma's correction for the stage and
 * graph aspect ratios. Rather than re-derive that matrix, `unitVisibleExtent`
 * asks sigma to convert the two stage corners with a unit camera override —
 * exact by construction, and it tracks any future change to sigma's math.
 */

import { rDebug, rInfo, rWarn } from '../../rendererLogger'

/** Zoom bounds. Sigma's ratio grows as the camera zooms OUT; the coarsening threshold is 4, so the ceiling must sit above it. */
export const MIN_CAMERA_RATIO = 0.02
export const MAX_CAMERA_RATIO = 16
/** Room left around a fitted subset, as a multiple of its extent. */
export const FIT_PADDING = 1.2
/** How far in a focus lands when the camera is currently zoomed out past it. */
export const FOCUS_RATIO = 0.35
export const CAMERA_ANIMATION_MS = 300

export interface FramedPoint {
  x: number
  y: number
}

export interface FramedBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface CameraTarget {
  x: number
  y: number
  ratio: number
}

export interface RatioBounds {
  minRatio?: number
  maxRatio?: number
}

export function clampRatio(ratio: number, bounds: RatioBounds = {}): number {
  const min = bounds.minRatio ?? MIN_CAMERA_RATIO
  const max = bounds.maxRatio ?? MAX_CAMERA_RATIO
  return Math.min(max, Math.max(min, ratio))
}

/** Bounding box of `points`, or null for an empty set. */
export function boundsOf(points: Iterable<FramedPoint>): FramedBounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    any = true
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return any ? { minX, minY, maxX, maxY } : null
}

/**
 * The camera that shows `bounds` with `padding` room around it.
 * `visibleAtUnitRatio` is the framed extent the stage shows at ratio 1; the
 * ratio needed is the larger of the two axis ratios, so the subset fits in
 * both directions. A single point (zero extent) resolves to `FOCUS_RATIO`.
 */
export function cameraStateForBounds(
  bounds: FramedBounds,
  visibleAtUnitRatio: { width: number; height: number },
  options: RatioBounds & { padding?: number } = {},
): CameraTarget {
  const padding = options.padding ?? FIT_PADDING
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const byWidth = visibleAtUnitRatio.width > 0 ? (width * padding) / visibleAtUnitRatio.width : 0
  const byHeight = visibleAtUnitRatio.height > 0 ? (height * padding) / visibleAtUnitRatio.height : 0
  const raw = Math.max(byWidth, byHeight)
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    ratio: clampRatio(raw > 0 ? raw : FOCUS_RATIO, options),
  }
}

/** Centre on `point`, zooming in to `FOCUS_RATIO` unless the camera is already closer. */
export function cameraStateForFocus(point: FramedPoint, currentRatio: number, options: RatioBounds = {}): CameraTarget {
  return { x: point.x, y: point.y, ratio: clampRatio(Math.min(currentRatio, FOCUS_RATIO), options) }
}

/** A camera command as a caller issues it. */
export type CameraCommand =
  | { kind: 'fit-all' }
  | { kind: 'fit-nodes'; nodeIds: string[] }
  | { kind: 'focus'; nodeId: string }
  /** Centre on a node, keeping the current ratio — a click's glide, which must not fight the operator's zoom. */
  | { kind: 'center-node'; nodeId: string }
  /** Centre on a point in GRAPH coordinates (the minimap's click), keeping the current ratio. */
  | { kind: 'center'; x: number; y: number }

/** A command as the store records it. `seq` makes every request distinct so the same command twice is applied twice. */
export type CameraRequest = CameraCommand & { seq: number }

/** The slice of a sigma instance the camera commands read and write. */
export interface CameraSigma {
  getCamera(): {
    ratio: number
    animate(state: Partial<CameraTarget>, opts?: { duration?: number }): Promise<void>
    animatedReset(opts?: { duration?: number }): Promise<void>
  }
  getDimensions(): { width: number; height: number }
  getNodeDisplayData(key: string): FramedPoint | undefined
  viewportToFramedGraph(point: FramedPoint, override?: { cameraState?: { x: number; y: number; angle: number; ratio: number } }): FramedPoint
  graphToViewport(point: FramedPoint): FramedPoint
}

/** The framed-graph extent the stage shows at ratio 1, centred. */
export function unitVisibleExtent(sigma: CameraSigma): { width: number; height: number } {
  const { width, height } = sigma.getDimensions()
  const unit = { x: 0.5, y: 0.5, angle: 0, ratio: 1 }
  const a = sigma.viewportToFramedGraph({ x: 0, y: 0 }, { cameraState: unit })
  const b = sigma.viewportToFramedGraph({ x: width, y: height }, { cameraState: unit })
  return { width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}

/**
 * Resolve a request against the live sigma instance and animate the camera.
 * Returns the target applied, or null when the request had nothing to aim
 * at (no such node, an empty subset) — logged, never thrown.
 *
 * `onSettled` fires once the request is over: after the animation lands, or
 * at once when there was nothing to aim at. It is how the store learns the
 * picture has actually moved, which a caller waiting on the camera (an agent
 * tool acknowledging "look here") needs and the synchronous return cannot say.
 */
export function applyCameraRequest(sigma: CameraSigma, request: CameraRequest, onSettled?: () => void): CameraTarget | null {
  const camera = sigma.getCamera()
  const startedAt = Date.now()
  const done = (target: CameraTarget | null): void => {
    rInfo('graph_view', 'graph_view: camera moved', {
      kind: request.kind,
      seq: request.seq,
      ratio: target?.ratio ?? 1,
      durationMs: Date.now() - startedAt,
    })
    onSettled?.()
  }

  if (request.kind === 'fit-all') {
    void camera.animatedReset({ duration: CAMERA_ANIMATION_MS }).then(() => done({ x: 0.5, y: 0.5, ratio: 1 }))
    return { x: 0.5, y: 0.5, ratio: 1 }
  }

  let target: CameraTarget | null = null
  if (request.kind === 'fit-nodes') {
    const points: FramedPoint[] = []
    for (const id of request.nodeIds) {
      const d = sigma.getNodeDisplayData(id)
      if (d) points.push({ x: d.x, y: d.y })
    }
    const bounds = boundsOf(points)
    if (!bounds) {
      rWarn('graph_view', 'graph_view: camera request had no target', { kind: request.kind, seq: request.seq, requested: request.nodeIds.length })
      onSettled?.()
      return null
    }
    target = cameraStateForBounds(bounds, unitVisibleExtent(sigma))
  } else if (request.kind === 'focus') {
    const d = sigma.getNodeDisplayData(request.nodeId)
    if (!d) {
      rWarn('graph_view', 'graph_view: camera request had no target', { kind: request.kind, seq: request.seq, nodeId: request.nodeId })
      onSettled?.()
      return null
    }
    target = cameraStateForFocus({ x: d.x, y: d.y }, camera.ratio)
  } else if (request.kind === 'center-node') {
    const d = sigma.getNodeDisplayData(request.nodeId)
    if (!d) {
      rWarn('graph_view', 'graph_view: camera request had no target', { kind: request.kind, seq: request.seq, nodeId: request.nodeId })
      onSettled?.()
      return null
    }
    target = { x: d.x, y: d.y, ratio: camera.ratio }
  } else {
    const framed = sigma.viewportToFramedGraph(sigma.graphToViewport({ x: request.x, y: request.y }))
    target = { x: framed.x, y: framed.y, ratio: camera.ratio }
  }

  rDebug('graph_view', 'graph_view: camera request resolved', { kind: request.kind, seq: request.seq, x: target.x, y: target.y, ratio: target.ratio })
  void camera.animate(target, { duration: CAMERA_ANIMATION_MS }).then(() => done(target))
  return target
}
