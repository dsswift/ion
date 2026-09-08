/**
 * Eased emphasis: the per-node strength the reducers dim against, advanced
 * a step at a time toward its target so a hover or a selection fades the
 * rest of the graph in rather than snapping.
 *
 * Sigma's reducers are stateless per refresh, so the state lives here: two
 * levels per node, `node` (1 when the node is in the emphasis set, 0 when
 * it should be dimmed) and `seed` (1 when the node is itself a seed — a
 * selected, highlighted, or hovered node — which is what an edge must
 * touch to stay lit). Both move toward their targets by a fixed fraction
 * per step, the way a lerp with retention does, so a change that lands
 * mid-fade continues from where the fade is rather than restarting.
 *
 * Only nodes a target names are tracked one by one. Every other node — the
 * thousands outside any neighbourhood — reads one shared `floor`, which is
 * what fades when an emphasis first appears (1 down to 0) or finally clears
 * (0 back to 1). That keeps a hover on a corpus of thousands to a handful
 * of map entries and one number per frame.
 *
 * Pure: the render layer owns the animation frame and calls `step()` until
 * it returns false, refreshing the stage on every step it took.
 */

/** Fraction of the remaining distance closed per step. At 60 Hz, 0.25 settles in about a quarter of a second. */
export const FADE_STEP = 0.25
/** A level this close to its target snaps to it, so a fade ends instead of asymptoting. */
const SETTLE_EPSILON = 0.01

export interface EmphasisTarget {
  /** The nodes that stay lit. Null means no emphasis at all: every level returns to 1. */
  emphasis: ReadonlySet<string> | null
  /** The seeds the emphasis grew from; an edge touching one stays lit. */
  seeds: ReadonlySet<string>
}

export interface EmphasisLevels {
  /** Whether any dimming is in force: a target is set or a fade back to full is still running. */
  active(): boolean
  /** 1 lit, 0 fully dimmed, in between while fading. */
  node(id: string): number
  /** 1 when the node is (or is still fading from being) a seed. */
  seed(id: string): number
}

export interface EmphasisFader extends EmphasisLevels {
  /** Replace the target. Returns whether a step is now needed. */
  setTarget(target: EmphasisTarget): boolean
  /** Advance every level one step toward its target. Returns whether another step is needed. */
  step(): boolean
  /** Jump every level to its target. */
  settle(): void
}

const NO_TARGET: EmphasisTarget = { emphasis: null, seeds: new Set() }

function approach(level: number, want: number): number {
  const next = level + (want - level) * FADE_STEP
  return Math.abs(next - want) < SETTLE_EPSILON ? want : next
}

export function createEmphasisFader(): EmphasisFader {
  let target: EmphasisTarget = NO_TARGET
  /** Per-node levels for the nodes a target names. Entries at their target are kept while the floor moves, so they never fall back to it. */
  const nodeLevels = new Map<string, number>()
  const seedLevels = new Map<string, number>()
  /** The level every untracked node reads: 1 with no target, 0 with one, and in between while the whole graph fades. */
  let floor = 1

  const wantNode = (id: string): number => (target.emphasis === null || target.emphasis.has(id) ? 1 : 0)
  const wantSeed = (id: string): number => (target.seeds.has(id) ? 1 : 0)
  const wantFloor = (): number => (target.emphasis === null ? 1 : 0)

  const node = (id: string): number => nodeLevels.get(id) ?? (wantNode(id) === 1 && target.emphasis !== null ? 1 : floor)
  const seed = (id: string): number => seedLevels.get(id) ?? wantSeed(id)
  const moving = (): boolean => floor !== wantFloor() || [...nodeLevels].some(([id, level]) => level !== wantNode(id)) || [...seedLevels].some(([id, level]) => level !== wantSeed(id))

  return {
    setTarget(next) {
      // Every node either target names, plus every node mid-fade, reads its
      // current level BEFORE the switch, so a change that lands mid-fade
      // continues from where the fade is. The reads go through `node` and
      // `seed`, so an untracked outsider picks up the floor it was showing.
      const touched = new Set<string>([...(target.emphasis ?? []), ...(next.emphasis ?? []), ...target.seeds, ...next.seeds, ...nodeLevels.keys(), ...seedLevels.keys()])
      const nodeNow = new Map<string, number>()
      const seedNow = new Map<string, number>()
      for (const id of touched) {
        nodeNow.set(id, node(id))
        seedNow.set(id, seed(id))
      }
      target = next
      nodeLevels.clear()
      seedLevels.clear()
      for (const [id, level] of nodeNow) nodeLevels.set(id, level)
      for (const [id, level] of seedNow) seedLevels.set(id, level)
      return moving()
    },
    step() {
      for (const [id, level] of nodeLevels) nodeLevels.set(id, approach(level, wantNode(id)))
      for (const [id, level] of seedLevels) seedLevels.set(id, approach(level, wantSeed(id)))
      floor = approach(floor, wantFloor())
      if (!moving()) {
        // Settled: the tracked entries all equal their targets, which the
        // default reads reproduce, so they can go.
        nodeLevels.clear()
        seedLevels.clear()
        return false
      }
      return true
    },
    settle() {
      nodeLevels.clear()
      seedLevels.clear()
      floor = wantFloor()
    },
    active: () => target.emphasis !== null || floor !== 1 || nodeLevels.size > 0 || seedLevels.size > 0,
    node,
    seed,
  }
}
