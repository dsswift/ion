/**
 * Proportional pane sizing for the git panel.
 *
 * A faithful port of the sizing core of VS Code's SplitView
 * (`src/vs/base/browser/ui/splitview/splitview.ts`) and PaneView, reduced to
 * what this panel needs: a fixed, ordered set of panes, no reordering, one
 * orientation.
 *
 * ── Why a port rather than bespoke arithmetic ───────────────────────────────
 * The previous model was a single `splitRatio` scalar governing Changes vs
 * Graph, with Worktrees and Integration pinned to hardcoded body constants.
 * Three consequences the operator hit directly:
 *
 *   - Only two of four sections could ever be resized. The other two were
 *     stuck at 132px and 148px regardless of content or free space.
 *   - Collapsing sections shrank the PANEL instead of redistributing their
 *     space, because nothing was allowed to grow into it.
 *   - With one section open it still could not take the full height.
 *
 * None of that is fixable by extending the scalar; it needs a real sizing
 * model. VS Code's is the reference implementation of exactly this UI, so the
 * algorithm is ported rather than reinvented.
 *
 * ── The three functions that matter ─────────────────────────────────────────
 * 1. `layout()` — pixels are DERIVED from proportions on every layout:
 *    `clamp(round(proportion * size / total), min, max)`. Proportions are the
 *    persisted form, which is what makes a sizing survive a window resize or a
 *    different panel height (overlay vs ATV).
 * 2. `distributeEmptySpace()` — after any sizing pass, any pixel not assigned
 *    to a pane is pushed into panes that can still grow. This is the
 *    conservation guarantee; its absence is what produced the dead band.
 * 3. `resize()` — a drag walks OUTWARD from the sash in both directions, so
 *    when the immediate neighbour hits its minimum the delta continues into
 *    the next pane. That is why dragging feels continuous rather than hitting
 *    a wall at the first neighbour.
 *
 * ── Collapsed panes are not a special case ──────────────────────────────────
 * PaneView expresses collapse purely through the size bounds:
 * `minimumSize = header + (expanded ? minimumBody : 0)`, same for maximum. A
 * collapsed pane therefore clamps to exactly its header and the ordinary
 * algorithm does the rest. "One pane open takes the whole panel" needs no
 * branch — it falls out of the clamp.
 */

/** Every section header is the same height. */
export const SECTION_HEADER = 28
/** Panel title row (close button, repo name, refresh). */
export const PANEL_HEADER = 28
/** A draggable boundary between two expanded panes. */
export const SASH_SIZE = 4

/** Stable identity for each pane. Order here is render order. */
export type PaneId = 'changes' | 'worktrees' | 'graph'

export const PANE_ORDER: readonly PaneId[] = ['changes', 'worktrees', 'graph']

/**
 * Smallest body height per pane, in pixels.
 *
 * A minimum exists to stop a drag crushing a pane into uselessness — it is NOT
 * a statement of preferred size. Preference is expressed by the proportions,
 * which the operator controls; the minimum is only the floor.
 *
 * Sized for THIS panel, which is 400-520px tall. VS Code's PaneView defaults to
 * a 120px minimum body, but it lives in a full-height sidebar; three panes at
 * that floor need 384px of a 442px budget here, leaving nothing to distribute.
 * Graph keeps a slightly higher floor because a commit graph with fewer than a
 * few rows conveys nothing, while a file list is still readable at two.
 */
export const MIN_BODY: Record<PaneId, number> = {
  changes: 56,
  // Holds the bench bar plus the worktree rows, which used to be two panes with
  // two floors and two headers for one concept.
  worktrees: 72,
  graph: 72,
}

/** Proportion of the panel each pane holds. Values are normalised on read. */
export type PaneProportions = Partial<Record<PaneId, number>>

export interface PaneState {
  id: PaneId
  /** False when the operator collapsed it; only the header is then rendered. */
  expanded: boolean
}

export interface PaneLayoutInput {
  /** Total height available to the panel, including its own title row. */
  height: number
  /** Panes in render order, with their expanded state. */
  panes: PaneState[]
  /** Persisted proportions. Missing entries fall back to an equal share. */
  proportions: PaneProportions
  /** Hidden panes are not rendered at all (bench mode hides Changes + Graph). */
  hidden?: readonly PaneId[]
}

export interface PaneSize {
  id: PaneId
  /** Header + body. */
  total: number
  /** Body only; 0 when collapsed. */
  body: number
  expanded: boolean
}

export interface PaneLayout {
  sizes: PaneSize[]
  /** Index pairs with a draggable boundary between them. */
  sashes: Array<{ afterId: PaneId; beforeId: PaneId }>
  /** Sum of every rendered pane plus sashes plus the panel header. */
  total: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Bounds for one pane, mirroring PaneView.minimumSize / maximumSize.
 *
 * `scale` shrinks the minimum body when the panel is too short to honour every
 * pane's floor at once (see `minimumScale`). Without it the sum of minimums
 * could exceed the available height and the panel would overflow its container
 * — trading a dead band for a clipped one.
 */
function bounds(pane: PaneState, scale = 1): { min: number; max: number } {
  const min = SECTION_HEADER + (pane.expanded ? Math.floor(MIN_BODY[pane.id] * scale) : 0)
  // An expanded pane may grow without bound; a collapsed one is exactly its
  // header. Same shape as PaneView, where maximumBodySize is only added when
  // expanded.
  const max = pane.expanded ? Number.POSITIVE_INFINITY : SECTION_HEADER
  return { min, max }
}

/**
 * How far every minimum must shrink for the expanded panes to fit.
 *
 * 1 when they already fit, which is the normal case. Below 1 only when the
 * operator has opened more panes than the panel height can floor — then every
 * pane gives up the same FRACTION of its minimum, so their relative floors are
 * preserved and no single pane is singled out to absorb the shortfall.
 *
 * Conservation wins over the floors here deliberately: a panel that overflows
 * its container clips content with no scrollbar, which is strictly worse than
 * a pane rendering slightly shorter than its nominal minimum.
 */
function minimumScale(expanded: PaneState[], pool: number): number {
  const required = expanded.reduce((a, p) => a + SECTION_HEADER + MIN_BODY[p.id], 0)
  if (required <= pool || required === 0) return 1
  const headers = expanded.length * SECTION_HEADER
  const bodyPool = Math.max(0, pool - headers)
  const bodyRequired = required - headers
  return bodyRequired > 0 ? bodyPool / bodyRequired : 0
}

/**
 * Compute pixel sizes for every visible pane.
 *
 * Mirrors `SplitView.layout()` followed by `distributeEmptySpace()`: derive
 * from proportions, clamp to bounds, then push any leftover into panes that
 * can still take it so the panel is always exactly filled.
 */
export function computePaneLayout(input: PaneLayoutInput): PaneLayout {
  const hidden = new Set(input.hidden ?? [])
  const visible = input.panes.filter((p) => !hidden.has(p.id))

  const sashCount = Math.max(0, visible.filter((p) => p.expanded).length - 1)
  const available = Math.max(0, input.height - PANEL_HEADER - sashCount * SASH_SIZE)

  // Expanded panes share the space left after every collapsed pane has taken
  // its header. Collapsed panes never participate in the proportional split.
  const collapsedTotal = visible.filter((p) => !p.expanded).length * SECTION_HEADER
  const expanded = visible.filter((p) => p.expanded)
  const poolForExpanded = Math.max(0, available - collapsedTotal)

  const sizes = new Map<PaneId, number>()
  for (const pane of visible) {
    if (!pane.expanded) sizes.set(pane.id, SECTION_HEADER)
  }

  const scale = minimumScale(expanded, poolForExpanded)

  if (expanded.length > 0) {
    // Normalise over the EXPANDED panes only. A pane with no stored proportion
    // takes an equal share, so a newly added pane behaves sensibly rather than
    // collapsing to its minimum.
    const equal = 1 / expanded.length
    const raw = expanded.map((p) => input.proportions[p.id] ?? equal)
    const total = raw.reduce((a, b) => a + b, 0) || 1

    for (let i = 0; i < expanded.length; i++) {
      const pane = expanded[i]
      const { min, max } = bounds(pane, scale)
      sizes.set(pane.id, clamp(Math.round((raw[i] / total) * poolForExpanded), min, max))
    }

    distributeEmptySpace(expanded, sizes, available - collapsedTotal, scale)
  }

  const paneSizes: PaneSize[] = visible.map((p) => {
    const total = sizes.get(p.id) ?? SECTION_HEADER
    return { id: p.id, total, body: Math.max(0, total - SECTION_HEADER), expanded: p.expanded }
  })

  // A sash sits between consecutive EXPANDED panes only: there is nothing to
  // redistribute across a collapsed one.
  const sashes: Array<{ afterId: PaneId; beforeId: PaneId }> = []
  const expandedVisible = visible.filter((p) => p.expanded)
  for (let i = 0; i < expandedVisible.length - 1; i++) {
    sashes.push({ afterId: expandedVisible[i].id, beforeId: expandedVisible[i + 1].id })
  }

  return {
    sizes: paneSizes,
    sashes,
    total: PANEL_HEADER + paneSizes.reduce((a, p) => a + p.total, 0) + sashes.length * SASH_SIZE,
  }
}

/**
 * Push any unassigned pixels into panes that can still grow (or reclaim from
 * panes that overflowed).
 *
 * Ported from `SplitView.distributeEmptySpace`. Rounding in the proportional
 * pass and clamping at the bounds both leave remainders; without this the
 * leftover is silently absorbed by whichever DOM node happens to flex, which
 * is exactly how the dead band at the bottom of the panel appeared.
 */
function distributeEmptySpace(panes: PaneState[], sizes: Map<PaneId, number>, target: number, scale = 1): void {
  const content = panes.reduce((a, p) => a + (sizes.get(p.id) ?? 0), 0)
  let delta = target - content

  // Walk in reverse, matching upstream: the last pane absorbs first, so the
  // top of the panel stays visually stable while the bottom takes the slack.
  for (let i = panes.length - 1; delta !== 0 && i >= 0; i--) {
    const pane = panes[i]
    const { min, max } = bounds(pane, scale)
    const current = sizes.get(pane.id) ?? min
    const next = clamp(current + delta, min, max)
    delta -= next - current
    sizes.set(pane.id, next)
  }
}

/**
 * Apply a sash drag and return the new proportions.
 *
 * `delta` is the cursor movement in pixels: positive grows the pane above the
 * sash. Ported from `SplitView.resize` — the delta is applied outward in both
 * directions, so when the immediate neighbour reaches its minimum the
 * remainder continues into the next pane rather than stalling.
 *
 * Returns proportions rather than pixels because proportions are what persist:
 * a sizing made at one panel height must still mean something at another.
 */
export function resizePanes(
  input: PaneLayoutInput,
  sashIndex: number,
  delta: number,
): PaneProportions {
  const hidden = new Set(input.hidden ?? [])
  const expanded = input.panes.filter((p) => !hidden.has(p.id) && p.expanded)
  if (sashIndex < 0 || sashIndex >= expanded.length - 1) return input.proportions

  const layout = computePaneLayout(input)
  const byId = new Map(layout.sizes.map((s) => [s.id, s.total]))
  // Same scale the layout used, so a drag cannot push a pane below the floor
  // the layout is currently enforcing.
  const sashCount = Math.max(0, expanded.length - 1)
  const collapsedCount = input.panes.filter((p) => !hidden.has(p.id) && !p.expanded).length
  const pool = Math.max(0, input.height - PANEL_HEADER - sashCount * SASH_SIZE - collapsedCount * SECTION_HEADER)
  const scale = minimumScale(expanded, pool)
  const current = expanded.map((p) => byId.get(p.id) ?? bounds(p, scale).min)

  // Panes above the sash grow with a positive delta; panes below shrink.
  const upIndexes: number[] = []
  for (let i = sashIndex; i >= 0; i--) upIndexes.push(i)
  const downIndexes: number[] = []
  for (let i = sashIndex + 1; i < expanded.length; i++) downIndexes.push(i)

  // How far the delta can travel before every pane on one side is pinned.
  const minDeltaUp = upIndexes.reduce((r, i) => r + (bounds(expanded[i], scale).min - current[i]), 0)
  const maxDeltaDown = downIndexes.reduce((r, i) => r + (current[i] - bounds(expanded[i], scale).min), 0)
  const clamped = clamp(delta, minDeltaUp, maxDeltaDown)

  const next = current.slice()
  for (let i = 0, up = clamped; i < upIndexes.length; i++) {
    const idx = upIndexes[i]
    const { min, max } = bounds(expanded[idx], scale)
    const size = clamp(current[idx] + up, min, max)
    up -= size - current[idx]
    next[idx] = size
  }
  for (let i = 0, down = clamped; i < downIndexes.length; i++) {
    const idx = downIndexes[i]
    const { min, max } = bounds(expanded[idx], scale)
    const size = clamp(current[idx] - down, min, max)
    down += size - current[idx]
    next[idx] = size
  }

  // saveProportions: store each pane's share of the CONTENT, not of the panel,
  // so the values stay meaningful when the panel height changes.
  const contentSize = next.reduce((a, b) => a + b, 0) || 1
  const out: PaneProportions = { ...input.proportions }
  for (let i = 0; i < expanded.length; i++) out[expanded[i].id] = next[i] / contentSize
  return out
}
