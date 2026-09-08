/**
 * Overlap resolution — a deterministic relaxation pass run once after the
 * force layout settles, so that high-degree nodes stop drawing on top of
 * one another.
 *
 * Why this is a separate pass rather than ForceAtlas2's own `adjustSizes`:
 * FA2 treats a node's `size` as a radius in GRAPH units, while Sigma draws
 * it in SCREEN pixels (`itemSizesReference: "screen"`). A size of 15 next to
 * coordinates spanning thousands of units is a rounding error to FA2 and a
 * 30px disc on the stage, so FA2's anti-collision cannot see the overlap the
 * operator sees. Collision is only definable once a pixels→units conversion
 * exists, and that conversion needs the viewport — which is why this runs at
 * the render layer, from `GraphCanvas`, and not inside the layout worker.
 *
 * The conversion matches Sigma's own framing: with `autoRescale` on, the
 * graph's larger extent is mapped onto the smaller viewport dimension at
 * camera ratio 1, so one pixel is `span / min(width, height)` graph units.
 * `unitsPerPixel` is computed once from the pre-pass extent and held fixed;
 * relaxation only ever grows the extent, so holding it fixed leaves nodes
 * slightly further apart than strictly required rather than closer.
 */

import type Graph from 'graphology'
import { nodeRenderSize } from './graph-node-size'

const DEFAULT_PADDING_PX = 2
const DEFAULT_MAX_ITERATIONS = 80
/**
 * How far a node may be pushed from where the layout put it, as a multiple
 * of its own radius.
 *
 * Without a cap this pass is not a correction, it is a second layout: in a
 * region the simulation left dense, the only arrangement with no overlaps at
 * all is a close packing, so the pass inflates that region into an evenly
 * spaced disc and erases the structure underneath it. Bounded, it separates
 * what it can and leaves a genuinely over-dense core slightly overlapping —
 * which is what zooming in is for.
 */
const MAX_DISPLACEMENT_RADII = 4
/** Jacobi damping: apply a fraction of each computed push so opposing pairs do not oscillate. */
const DAMPING = 0.5
/** Below this separation two nodes are treated as colocated. */
const EPSILON = 1e-6
/**
 * Penetration below half a screen pixel counts as resolved. Damped Jacobi
 * relaxation approaches contact asymptotically and never reaches exactly
 * zero, so an exact-zero stop condition would always spend the full
 * iteration budget on a layout that is already visually clean.
 */
const RESOLVED_TOLERANCE_PX = 0.5
/** Golden angle — spreads a pre-dispersal spiral evenly, and deterministically. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export interface OverlapViewport {
  width: number
  height: number
}

export interface OverlapOptions {
  /** Clear space to keep between two node edges, in screen pixels. */
  paddingPx?: number
  maxIterations?: number
  /**
   * When set, only these nodes may be displaced. Everything else still
   * collides — it just holds its ground. This is what lets a drag push the
   * nodes around the cursor out of the way without disturbing the rest of a
   * layout the operator has already arranged.
   */
  movable?: Set<string>
  /**
   * Skip the pre-dispersal of exactly-colocated nodes. During a drag the
   * caller wants a few cheap refinement passes, not a re-seed.
   */
  skipPredisperse?: boolean
}

export interface OverlapResult {
  /** Relaxation passes actually run — fewer than the cap means it converged. */
  iterations: number
  /** Nodes whose position this pass changed. */
  movedNodes: number
  /** Graph units per screen pixel at camera ratio 1, the conversion the pass used. */
  unitsPerPixel: number
  /** Pairs still overlapping when the pass stopped. Non-zero means the cap was hit. */
  remainingOverlaps: number
}

interface Body {
  id: string
  x: number
  y: number
  r: number
  movable: boolean
}

function readBodies(graph: Graph, movable: Set<string> | undefined): Body[] {
  const bodies: Body[] = []
  graph.forEachNode((id, attrs) => {
    const x = attrs.x as number
    const y = attrs.y as number
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const size =
      typeof attrs.size === 'number' && Number.isFinite(attrs.size)
        ? attrs.size
        : nodeRenderSize(String(attrs.kind ?? 'document'), typeof attrs.degree === 'number' ? attrs.degree : 0)
    bodies.push({ id, x, y, r: size, movable: movable ? movable.has(id) : true })
  })
  return bodies
}

/**
 * One relaxation pass over a uniform grid. Returns the number of overlapping
 * pairs found, and writes the accumulated displacement into `dx`/`dy`.
 */
function relaxOnce(bodies: Body[], dx: Float64Array, dy: Float64Array, contacts: Float64Array, cellSize: number, tolerance: number): number {
  dx.fill(0)
  dy.fill(0)
  contacts.fill(0)

  const cells = new Map<string, number[]>()
  for (let i = 0; i < bodies.length; i++) {
    const key = `${Math.floor(bodies[i].x / cellSize)}|${Math.floor(bodies[i].y / cellSize)}`
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  }

  let overlaps = 0
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]
    const cx = Math.floor(a.x / cellSize)
    const cy = Math.floor(a.y / cellSize)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = cells.get(`${cx + ox}|${cy + oy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const b = bodies[j]
          const vx = b.x - a.x
          const vy = b.y - a.y
          const distance = Math.sqrt(vx * vx + vy * vy)
          const minimum = a.r + b.r
          if (distance >= minimum - tolerance) continue
          overlaps++
          // Pre-dispersal means an exactly-zero separation is rare, but a
          // pair can still land on it mid-pass; fall back to a stable
          // per-pair axis rather than a random one, so the pass stays
          // reproducible.
          const [ux, uy] =
            distance < EPSILON ? [Math.cos((i + j) * GOLDEN_ANGLE), Math.sin((i + j) * GOLDEN_ANGLE)] : [vx / distance, vy / distance]
          // A pair with one pinned end resolves entirely on the free end,
          // so a pinned neighbour is not silently dragged along and the
          // pair still separates by the full penetration.
          const share = a.movable && b.movable ? 2 : 1
          const push = ((minimum - distance) / share) * DAMPING
          if (a.movable) {
            dx[i] -= ux * push
            dy[i] -= uy * push
            contacts[i]++
          }
          if (b.movable) {
            dx[j] += ux * push
            dy[j] += uy * push
            contacts[j]++
          }
        }
      }
    }
  }

  // Average each node's pushes rather than summing them. A node inside a
  // dense pile takes a contact from every neighbour at once; summing those
  // vectors overshoots far past the free space and the pass oscillates
  // instead of settling.
  for (let i = 0; i < bodies.length; i++) {
    if (!bodies[i].movable) continue
    const n = contacts[i] || 1
    bodies[i].x += dx[i] / n
    bodies[i].y += dy[i] / n
  }
  return overlaps
}

/**
 * Nudge exactly-colocated nodes onto a deterministic golden-angle spiral
 * before relaxation starts.
 *
 * A pile of nodes sharing one coordinate has no separating direction at all,
 * and pairwise repulsion out of a single point converges slowly and
 * unevenly — a fresh corpus, whose fallback placement puts unresolved nodes
 * at the same spot, is exactly that case. Seeding a spread first turns the
 * relaxation into local refinement, which converges in a few passes.
 */
function predisperseColocated(bodies: Body[]): void {
  const seen = new Map<string, number>()
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    const key = `${b.x}|${b.y}`
    const rank = seen.get(key) ?? 0
    seen.set(key, rank + 1)
    if (rank === 0) continue
    const angle = rank * GOLDEN_ANGLE
    const radius = b.r * Math.sqrt(rank)
    b.x += Math.cos(angle) * radius
    b.y += Math.sin(angle) * radius
  }
}

/**
 * Push overlapping nodes apart in place, in graph space, so that no two
 * discs intersect when the graph is framed to `viewport` at camera ratio 1.
 * Positions are written back onto the graphology instance; the caller is
 * responsible for refreshing Sigma and for persisting the result.
 */
export function resolveNodeOverlaps(graph: Graph, viewport: OverlapViewport, options: OverlapOptions = {}): OverlapResult {
  const paddingPx = options.paddingPx ?? DEFAULT_PADDING_PX
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS

  const bodies = readBodies(graph, options.movable)
  const empty: OverlapResult = { iterations: 0, movedNodes: 0, unitsPerPixel: 0, remainingOverlaps: 0 }
  if (bodies.length < 2) return empty

  const viewportSide = Math.min(viewport.width, viewport.height)
  if (!Number.isFinite(viewportSide) || viewportSide <= 0) return empty

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const b of bodies) {
    if (b.x < minX) minX = b.x
    if (b.x > maxX) maxX = b.x
    if (b.y < minY) minY = b.y
    if (b.y > maxY) maxY = b.y
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const unitsPerPixel = span / viewportSide

  const origin = bodies.map((b) => ({ x: b.x, y: b.y }))
  let maxRadius = 0
  for (const b of bodies) {
    b.r = (b.r + paddingPx / 2) * unitsPerPixel
    if (b.r > maxRadius) maxRadius = b.r
  }

  if (!options.skipPredisperse) predisperseColocated(bodies)

  // The displacement budget is measured from the post-dispersal position:
  // dispersing exactly-colocated nodes is establishing a starting point, not
  // moving them away from one the layout chose.
  const budgetOrigin = bodies.map((b) => ({ x: b.x, y: b.y }))

  const dx = new Float64Array(bodies.length)
  const dy = new Float64Array(bodies.length)
  const contacts = new Float64Array(bodies.length)

  /** Hold every node within its displacement budget of where the layout put it. */
  function clampToBudget(): void {
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]
      if (!b.movable) continue
      const limit = b.r * MAX_DISPLACEMENT_RADII
      const ox = b.x - budgetOrigin[i].x
      const oy = b.y - budgetOrigin[i].y
      const distance = Math.sqrt(ox * ox + oy * oy)
      if (distance <= limit || distance < EPSILON) continue
      const scale = limit / distance
      b.x = budgetOrigin[i].x + ox * scale
      b.y = budgetOrigin[i].y + oy * scale
    }
  }
  const cellSize = Math.max(maxRadius * 2, EPSILON)
  const tolerance = RESOLVED_TOLERANCE_PX * unitsPerPixel

  let iterations = 0
  let remainingOverlaps = 0
  for (let pass = 0; pass < maxIterations; pass++) {
    iterations = pass + 1
    remainingOverlaps = relaxOnce(bodies, dx, dy, contacts, cellSize, tolerance)
    clampToBudget()
    if (remainingOverlaps === 0) break
  }

  let movedNodes = 0
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    if (b.x === origin[i].x && b.y === origin[i].y) continue
    movedNodes++
    graph.setNodeAttribute(b.id, 'x', b.x)
    graph.setNodeAttribute(b.id, 'y', b.y)
  }

  return { iterations, movedNodes, unitsPerPixel, remainingOverlaps }
}
