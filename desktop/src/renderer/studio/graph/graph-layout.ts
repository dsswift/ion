/**
 * Force layout — a warm simulation that runs when disturbed and pauses when
 * settled.
 *
 * The simulation turns an unordered corpus into a readable shape on the
 * first run, then stays alive, paused. A drag holds the grabbed node at the
 * cursor and wakes the simulation for the node's neighbourhood only (see
 * `LayoutRunOptions` and `graph-canvas-drag.ts`), so its neighbours are
 * pulled by the real link forces and the region re-settles around where it
 * was dropped while everything outside the confinement is held. An earlier
 * version re-ran the whole seeded layout on every drop, which rearranged
 * everything the operator had placed by hand, and a later one let the whole
 * graph move during the drag, which slid the picture for seconds after
 * every release — the fix is to never reseed, never replay a budget, and
 * confine what may move.
 *
 * ## What the settings are for
 *
 * The goal is an organic shape: communities as lobes, link chains as
 * branches, leaf clusters hanging off as peninsulas. Three of ForceAtlas2's
 * knobs decide whether that emerges or whether the corpus collapses into one
 * filled circle, and the defaults from `inferSettings` are tuned for the
 * latter — they exist to keep a graph compact enough to screenshot.
 *
 * - `strongGravityMode` pulls every node toward the centre with a force that
 *   does not fall off with distance. It is what makes a graph round. Off,
 *   and ordinary gravity is kept very low — it is there to stop
 *   disconnected fragments drifting away, not to shape the layout.
 * - `linLogMode` changes attraction from linear to logarithmic. It sharpens
 *   community boundaries, but it does so by pulling each one into a tight
 *   ball, and the balls then sit around one centre. Off, in favour of a
 *   large `scalingRatio`: the same separation, spread out.
 * - `outboundAttractionDistribution` divides a node's pull by its degree, so
 *   a hub stops reeling its whole neighbourhood into the core and leaf
 *   clusters swing out. On — this is what produces peninsulas.
 *
 * `adjustSizes` (anti-collision inside the simulation) stays OFF. It works in
 * graph units while Sigma draws radii in screen pixels, so it can only be
 * made meaningful by pinning the layout's scale — and pinning the scale is
 * itself a way of forcing the graph into a fixed circle. Overlap is resolved
 * once, exactly, after the run (`graph-overlap.ts`).
 *
 * ## When the run stops
 *
 * The run stops when the graph stops moving (`graph-layout-convergence.ts`),
 * not on a stopwatch. A timer cannot know whether the physics has settled:
 * a small corpus would burn seconds it did not need and a large one would be
 * frozen mid-motion. Two wall-clock bounds remain, but only as guards: a
 * short minimum so the first tick — before any force has acted — can never
 * count as still, and a long maximum so a simulation that never settles
 * (a pathological corpus, a stuck worker) still yields the canvas back.
 */

import type Graph from 'graphology'
import { nodeRenderSize } from './graph-node-size'
import { createConvergenceMonitor, type ConvergenceMonitor, type ConvergenceSample } from './graph-layout-convergence'
import { createLayoutSupervisor, type LayoutTickTiming, type StaleReplyInfo } from './graph-layout-supervisor'
import { LAYOUT_FORCES_LOBES, type LayoutForces } from '../../../shared/graph-view-types'

/** Below this the convergence monitor is not consulted; the seed is still being pulled apart. */
export const MIN_RUN_MS = 400
/** Backstop only. A run that reaches it is logged with `reason: 'budget'` so the constants can be tuned from the log. */
export const MAX_RUN_MS = 20000
/** A progress sample is reported every this many ticks, so a run that will not settle can be read from the log while it goes. */
export const PROGRESS_EVERY_TICKS = 100
/**
 * Worker iterations per round trip, by what started the run. A round trip
 * costs a full write-back on the main thread whatever the count, so more
 * iterations per trip is a stronger, faster pull per frame while the
 * operator's hand is on the graph. The first layout keeps to one: it is
 * watched for convergence per tick and every tick is drawn.
 */
export const ITERATIONS_BY_REASON: Record<LayoutRunReason, number> = { initial: 1, drag: 3, drop: 3, pins: 2, structure: 2, forces: 1 }

/** Golden angle — a phyllotaxis seed spreads points evenly with no clumping and no randomness. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** Free space left around each node inside its community, as a multiple of its own area. */
const MEMBER_AREA_SLACK = 6
/** Free space left between communities, as a multiple of their combined area. */
const COMMUNITY_AREA_SLACK = 4

function nodeRadius(attrs: Record<string, unknown>): number {
  const size = attrs.size
  if (typeof size === 'number' && Number.isFinite(size)) return size
  return nodeRenderSize(String(attrs.kind ?? 'document'), typeof attrs.degree === 'number' ? attrs.degree : 0)
}

/** Points on a phyllotaxis disc of `radius`, in a deterministic order. */
function spiralPoint(index: number, count: number, radius: number): { x: number; y: number } {
  const angle = index * GOLDEN_ANGLE
  const r = radius * Math.sqrt((index + 0.5) / Math.max(1, count))
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r }
}

interface SeedGroup {
  key: number
  ids: string[]
  radius: number
}

/**
 * Place every node NOT in `keep` — grouped by community, one disc per
 * community, the discs themselves spread on a larger disc.
 *
 * Seeding matters more than it looks. A force layout refines the shape it is
 * given within its budget; it does not reliably discover a global structure
 * from scratch in a few seconds. Seeding every node onto one uniform disc
 * therefore produces exactly what it describes — a uniform disc — while
 * seeding communities apart gives the simulation the separation to refine
 * and the lobes survive. The community assignment is already computed
 * (Louvain, in the model build), so this costs nothing to read.
 *
 * Returns the number of nodes placed.
 */
export function seedPositions(graph: Graph, keep: Set<string>): number {
  const groups = new Map<number, SeedGroup>()
  const areaOf = new Map<number, number>()
  let sumX = 0
  let sumY = 0
  let keptCount = 0

  graph.forEachNode((id, attrs) => {
    if (keep.has(id) && Number.isFinite(attrs.x) && Number.isFinite(attrs.y)) {
      sumX += attrs.x as number
      sumY += attrs.y as number
      keptCount++
      return
    }
    // Nodes with no community share the -1 group, which seeds them as one
    // loose ring rather than scattering them through everybody else.
    const key = typeof attrs.community === 'number' ? attrs.community : -1
    let group = groups.get(key)
    if (!group) {
      group = { key, ids: [], radius: 0 }
      groups.set(key, group)
      areaOf.set(key, 0)
    }
    group.ids.push(id)
    const r = nodeRadius(attrs)
    areaOf.set(key, areaOf.get(key)! + Math.PI * r * r * MEMBER_AREA_SLACK)
  })

  let placed = 0
  for (const group of groups.values()) {
    group.ids.sort()
    group.radius = Math.sqrt(areaOf.get(group.key)! / Math.PI)
    placed += group.ids.length
  }
  if (placed === 0) return 0

  // Largest communities first, so the biggest lobes take the middle and the
  // long tail of small ones rings the outside.
  const ordered = [...groups.values()].sort((a, b) => (b.ids.length !== a.ids.length ? b.ids.length - a.ids.length : a.key - b.key))
  const spreadArea = ordered.reduce((sum, g) => sum + Math.PI * g.radius * g.radius, 0) * COMMUNITY_AREA_SLACK
  const spreadRadius = Math.sqrt(spreadArea / Math.PI)
  const centre = keptCount > 0 ? { x: sumX / keptCount, y: sumY / keptCount } : { x: 0, y: 0 }

  ordered.forEach((group, groupIndex) => {
    const groupCentre = spiralPoint(groupIndex, ordered.length, spreadRadius)
    group.ids.forEach((id, i) => {
      const offset = spiralPoint(i, group.ids.length, group.radius)
      graph.setNodeAttribute(id, 'x', centre.x + groupCentre.x + offset.x)
      graph.setNodeAttribute(id, 'y', centre.y + groupCentre.y + offset.y)
    })
  })

  return placed
}

/** Why a run ended: the graph settled, or the backstop fired first. */
export type LayoutStopReason = 'converged' | 'budget'

/**
 * What started a run. Carried into `onCool` so the caller can treat a first
 * layout differently from a drop. `structure` is a rebuild that added nodes
 * (a layer toggled on) settling the additions in place; `forces` is the
 * operator changing a force parameter and watching the shape follow.
 */
export type LayoutRunReason = 'initial' | 'drag' | 'drop' | 'pins' | 'structure' | 'forces'

/**
 * Where a run's time went, summed over its round trips. A run's per-tick
 * cost can only be read from the log if the run reports it: a six-tick
 * settle produces no progress sample at all, and a wall-clock duration
 * cannot say whether the worker or the main thread's write-back was slow.
 */
export interface LayoutRunTiming {
  /** Round trips the supervisor completed during the run. */
  roundTrips: number
  /** Total time waiting on the worker, message transit included. */
  workerMs: number
  /** Total main-thread time writing replies back onto the graph. */
  writeBackMs: number
  /** The slowest single round trip. */
  maxRoundTripMs: number
  /** The slowest single write-back. */
  maxWriteBackMs: number
}

export interface LayoutCoolResult {
  reason: LayoutStopReason
  runReason: LayoutRunReason
  /** Layout ticks observed by the convergence monitor during this run. */
  ticks: number
  /** Normalized mean displacement on the last observed tick (0 when no tick was observed). */
  finalDisplacement: number
  durationMs: number
  timing: LayoutRunTiming
  /** Nodes the run let move; the whole graph when unconfined. */
  freeCount: number
  /**
   * Exactly which nodes the run let move, or null when it was unconfined.
   * The overlap pass needs the identities, not just the count: after a drop
   * it may only re-space what the drop disturbed.
   */
  freeIds: ReadonlySet<string> | null
}

/**
 * The subset of the layout supervisor the engine drives. `start()` builds
 * the worker's matrices from the graph's CURRENT positions, which is what
 * makes a resume after `stop()` a warm continuation rather than a restart.
 */
export interface LayoutSupervisor {
  start(): void
  stop(): void
  kill(): void
  setIterations(count: number): void
}

/**
 * A run confined to part of the graph. Every node outside `free` is held
 * for the run and released to its pinned state when the run cools, and
 * convergence is judged on the free nodes alone. This is what makes a drop
 * settle where the hand left things: the dropped node and the untouched
 * remainder anchor the region, so the nodes that moved with the hand find
 * a resting place near where they are instead of returning to where they
 * started.
 */
export interface LayoutRunOptions {
  free: ReadonlySet<string>
  /** The nodes that stay fixed once the run cools. */
  pinned: ReadonlySet<string>
}

export interface LayoutProgress {
  runReason: LayoutRunReason
  ticks: number
  displacement: number
  elapsedMs: number
}

/** Called for every node on every write-back; may return replacement attributes. Mirrors FA2's `outputReducer`. */
export type LayoutOutputReducer = (key: string, attrs: Record<string, unknown>) => Record<string, unknown>

export type SupervisorFactory = (graph: Graph, settings: Record<string, unknown>, outputReducer: LayoutOutputReducer) => LayoutSupervisor

export interface LayoutEngineOptions {
  /** Fired each time a run ends. Not fired by `kill()`. */
  onCool: (result: LayoutCoolResult) => void
  /** Fired each time a confinement is applied, with how many `fixed` flags it actually had to write. */
  onRestrict?: (info: { freeCount: number; flipped: number }) => void
  /** Fired each time a run starts (not on a reheat of a run already going). */
  onRun?: (reason: LayoutRunReason) => void
  /** Fired every `PROGRESS_EVERY_TICKS` ticks of a run. */
  onProgress?: (progress: LayoutProgress) => void
  /** Fired when the supervisor drops a reply from a superseded matrix. */
  onStaleReply?: (info: StaleReplyInfo) => void
  /** The force parameters the first run starts with. Defaults to the "Lobes" shape. */
  forces?: LayoutForces
  /** Overrides the backstop budget. */
  maxRunMs?: number
  /** Overrides the minimum before convergence is consulted. */
  minRunMs?: number
  /** Test seam: build the supervisor for `graph` and `settings`. */
  createSupervisor?: SupervisorFactory
}

/**
 * A long-lived simulation over one graphology instance.
 *
 * The worker stays alive between runs, paused. A run starts it from the
 * graph's current positions and watches for convergence; converged (or the
 * backstop) pauses it again. A resume never reseeds and never replays a
 * budget, and a disturbance is confined to the region it touches, so a
 * graph at rest that is disturbed in one place settles in that place.
 * That is what makes a drag feel like a spring rather than a relayout.
 */
export interface LayoutEngine {
  /**
   * Start a run, or — if one is going — reheat it by resetting the
   * convergence watch so the current disturbance must settle before the run
   * ends. Never restarts the worker mid-run.
   */
  run(reason: LayoutRunReason, options?: LayoutRunOptions): void
  running(): boolean
  /**
   * The node the pointer holds, with its cursor position. While held, the
   * worker's write-back is overridden for that node so the simulation cannot
   * pull it away from the cursor, and the matrix is refreshed from it so the
   * forces on its neighbours come from where it actually is. `null` releases.
   */
  hold(nodeId: string | null, at?: { x: number; y: number }): void
  /**
   * Replace the force parameters. A run in progress picks them up on its
   * next round trip; a paused engine holds them for the next run. The
   * caller starts a `forces` run to show the new shape.
   */
  setForces(forces: LayoutForces): void
  kill(): void
}

/** The FA2 settings a `LayoutForces` choice resolves to for a graph of `order` nodes. */
export function forceSettings(forces: LayoutForces, order: number): { gravity: number; scalingRatio: number; edgeWeightInfluence: number; slowDown: number } {
  return {
    gravity: forces.gravity,
    scalingRatio: forces.scalingRatio,
    edgeWeightInfluence: forces.edgeWeightInfluence,
    slowDown: (1 + Math.log(Math.max(1, order))) * forces.damping,
  }
}

let supervisorFactoryOverride: SupervisorFactory | null = null

function emptyTiming(): LayoutRunTiming {
  return { roundTrips: 0, workerMs: 0, writeBackMs: 0, maxRoundTripMs: 0, maxWriteBackMs: 0 }
}

/** Test-only: replace the FA2 worker supervisor for every engine created afterwards (jsdom has no Worker). */
export function _setSupervisorFactoryForTest(factory: SupervisorFactory | null): void {
  supervisorFactoryOverride = factory
}

export function createLayoutEngine(graph: Graph, options: LayoutEngineOptions): LayoutEngine {
  const maxRunMs = options.maxRunMs ?? MAX_RUN_MS
  const minRunMs = options.minRunMs ?? MIN_RUN_MS
  // Per-run accounting of what each round trip cost, reported at cool.
  let timing: LayoutRunTiming = emptyTiming()
  const onTick = (tick: LayoutTickTiming): void => {
    timing.roundTrips++
    timing.workerMs += tick.roundTripMs
    timing.writeBackMs += tick.writeBackMs
    if (tick.roundTripMs > timing.maxRoundTripMs) timing.maxRoundTripMs = tick.roundTripMs
    if (tick.writeBackMs > timing.maxWriteBackMs) timing.maxWriteBackMs = tick.writeBackMs
  }
  const defaultSupervisorFactory: SupervisorFactory = (g, s, outputReducer) =>
    createLayoutSupervisor(g, { settings: s, outputReducer, onStaleReply: options.onStaleReply, onTick })

  // Mutated in place by `setForces`: the supervisor reads this object on
  // every request, so a change reaches the worker without a restart.
  const settings: Record<string, unknown> = {
    barnesHutOptimize: graph.order > 500,
    // linLog makes attraction logarithmic, which pulls every community into
    // a tight ball around the centre — the "constrained to a central
    // gravity point" shape. Linear attraction with a large repulsion scale
    // spreads the same structure out instead.
    linLogMode: false,
    outboundAttractionDistribution: true,
    adjustSizes: false,
    strongGravityMode: false,
    // The operator's force parameters: gravity (just enough centring to keep
    // disconnected fragments from drifting off, by default), the repulsion
    // scale, link influence, and damping. See `LayoutForces`.
    ...forceSettings(options.forces ?? LAYOUT_FORCES_LOBES, graph.order),
  }

  let held: { id: string; x: number; y: number } | null = null
  // FA2 writes the matrix back onto every node before calling this, so the
  // cursor position the drag wrote to the graph is already gone by the time
  // we see the node — it is restored from `held`, and the supervisor then
  // reads the graph back into the matrix, so the worker sees the node where
  // the pointer is.
  const outputReducer: LayoutOutputReducer = (key, attrs) => {
    if (held && key === held.id) return { ...attrs, x: held.x, y: held.y }
    return attrs
  }

  const create = options.createSupervisor ?? supervisorFactoryOverride ?? defaultSupervisorFactory
  let supervisor: LayoutSupervisor | null = null
  let killed = false
  let running = false
  let runReason: LayoutRunReason = 'initial'
  let runStartedAt = 0
  let monitor: ConvergenceMonitor | null = null
  let backstop: ReturnType<typeof setTimeout> | null = null
  let deferredFinish: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (backstop) clearTimeout(backstop)
    if (deferredFinish) clearTimeout(deferredFinish)
    backstop = null
    deferredFinish = null
  }

  // The restriction in force, if a run is confined (see `LayoutRunOptions`).
  // Held by identity: a drag hands the same options object to every reheat,
  // and re-applying an unchanged restriction is skipped outright.
  let restriction: LayoutRunOptions | null = null
  // Flags are written only where they change. Graphology reports each
  // `setNodeAttribute` as its own event and Sigma answers every one with a
  // reducer pass, so writing all N flags on every drag step cost N full
  // passes per pointer move; the handful that actually flip cost a handful.
  const writeFixed = (id: string, fixed: boolean): number => {
    if (graph.getNodeAttribute(id, 'fixed') === fixed) return 0
    graph.setNodeAttribute(id, 'fixed', fixed)
    return 1
  }
  const restrict = (next: LayoutRunOptions): void => {
    if (restriction === next) return
    restriction = next
    let flipped = 0
    graph.forEachNode((id) => {
      flipped += writeFixed(id, !next.free.has(id))
    })
    options.onRestrict?.({ freeCount: next.free.size, flipped })
  }
  // Release every held node to its pinned state. The held node (a drag in
  // progress) stays fixed: the hand, not the restriction, is holding it.
  const release = (): void => {
    if (!restriction) return
    const { pinned } = restriction
    restriction = null
    graph.forEachNode((id) => {
      writeFixed(id, pinned.has(id) || id === held?.id)
    })
  }

  const finish = (reason: LayoutStopReason, sample: ConvergenceSample | null): void => {
    if (killed || !running) return
    clearTimers()
    monitor?.dispose()
    monitor = null
    running = false
    const freeCount = restriction ? restriction.free.size : graph.order
    // Captured before `release()` clears the restriction.
    const freeIds = restriction ? new Set(restriction.free) : null
    release()
    supervisor?.stop()
    const runTiming = timing
    timing = emptyTiming()
    options.onCool({
      reason,
      runReason,
      ticks: sample?.ticks ?? 0,
      finalDisplacement: sample?.displacement ?? 0,
      durationMs: Date.now() - runStartedAt,
      timing: runTiming,
      freeCount,
      freeIds,
    })
  }

  const onSample = (sample: ConvergenceSample): void => {
    if (sample.ticks % PROGRESS_EVERY_TICKS !== 0) return
    options.onProgress?.({ runReason, ticks: sample.ticks, displacement: sample.displacement, elapsedMs: Date.now() - runStartedAt })
  }

  const onConverged = (sample: ConvergenceSample): void => {
    const elapsed = Date.now() - runStartedAt
    // Convergence observed before the minimum has elapsed is deferred, not
    // discarded: the monitor has already detached, so the run ends exactly
    // when the minimum does, with the sample that satisfied patience.
    if (elapsed >= minRunMs) finish('converged', sample)
    else deferredFinish = setTimeout(() => finish('converged', sample), minRunMs - elapsed)
  }

  return {
    run(reason, confine) {
      if (killed) return
      if (running) {
        // Reheat: the disturbance must settle before this run may end. A
        // deferred finish from an earlier convergence is void too. The
        // reason moves on (a drag becomes a drop) and the pace with it.
        runReason = reason
        supervisor?.setIterations(ITERATIONS_BY_REASON[reason])
        if (deferredFinish) {
          clearTimeout(deferredFinish)
          deferredFinish = null
        }
        // A confined run watches its free nodes; an unconfined one (a new
        // drag on a settling region) frees everything and watches it all.
        if (confine) restrict(confine)
        else release()
        monitor?.dispose()
        monitor = createConvergenceMonitor(graph, { onConverged, onSample, ...(confine ? { ids: [...confine.free] } : {}) })
        return
      }
      if (graph.order === 0) {
        options.onCool({ reason: 'converged', runReason: reason, ticks: 0, finalDisplacement: 0, durationMs: 0, timing: emptyTiming(), freeCount: 0, freeIds: null })
        return
      }
      running = true
      runReason = reason
      runStartedAt = Date.now()
      timing = emptyTiming()
      if (confine) restrict(confine)
      supervisor ??= create(graph, settings, outputReducer)
      supervisor.setIterations(ITERATIONS_BY_REASON[reason])
      supervisor.start()
      monitor = createConvergenceMonitor(graph, { onConverged, onSample, ...(confine ? { ids: [...confine.free] } : {}) })
      backstop = setTimeout(() => finish('budget', monitor?.last() ?? null), maxRunMs)
      options.onRun?.(reason)
    },
    running: () => running,
    hold(nodeId, at) {
      held = nodeId && at ? { id: nodeId, x: at.x, y: at.y } : null
    },
    setForces(forces) {
      Object.assign(settings, forceSettings(forces, graph.order))
    },
    kill() {
      if (killed) return
      killed = true
      clearTimers()
      monitor?.dispose()
      monitor = null
      running = false
      release()
      supervisor?.stop()
      supervisor?.kill()
      supervisor = null
    },
  }
}
