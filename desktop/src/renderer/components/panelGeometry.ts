/**
 * panelGeometry — the git panel's and file explorer's sizing constants, in one
 * place, with the pure math that turns them into pixels.
 *
 * ── Why a module and not literals at the call sites ─────────────────────────
 * The git panel's width was declared THREE times and the three disagreed:
 * `GitPanel` said 320, the wrapper positioning it in `App` said 280, and the
 * Status Drawer's offset hand-typed 296 (`8 + 280 + 8`) derived from the
 * wrapper. So the panel already overflowed its own wrapper by 40px, and the
 * drawer -- one z-index above -- overlapped the panel by 32px. Widening the
 * panel with three independent numbers would have widened that overlap to
 * 152px. One constant, and an offset COMPUTED from it, is what makes the
 * disagreement unrepresentable.
 *
 * The height math had the same shape: `(expandedUI ? 520 : 400) + 82` was
 * duplicated verbatim in `GitPanel` and `FileExplorer`, with a comment in the
 * second asking the reader to keep it matching the first.
 *
 * ── Why there is no `statusDrawerOffset` ────────────────────────────────────
 * There used to be one: the Status Drawer is anchored to the same right edge as
 * the git panel, so when both were open the drawer had to be pushed clear of the
 * panel. That offset was hand-typed as `296` (`8 + 280 + 8`) derived from the
 * WRAPPER's width while the panel itself said 320 -- so the drawer, one z-index
 * above, overlapped the panel by 32px. It was then rewritten to compute from
 * `GIT_PANEL_WIDTH`, which made the disagreement unrepresentable.
 *
 * The offset is gone entirely now, because the state it existed for is gone: at
 * most one right-side panel can be open (see `toggleGitPanel` /
 * `toggleStatusDrawer` / `openDispatchPreview` in `stores/slices/expand-slice.ts`),
 * so the drawer always sits at `PANEL_GAP` and has nothing to clear. The history
 * is recorded here because the lesson -- a width restated at a second site
 * drifts from the first -- outlives the function that taught it.
 */

/** Tab strip + border + gap + input pill: the chrome above and below a panel. */
export const PANEL_CHROME = 82
/** Body height in the normal layout. */
export const PANEL_BODY_DEFAULT = 400
/** Body height when the operator has expanded the UI. */
export const PANEL_BODY_EXPANDED = 520
/** Both panels are anchored this far above the bottom of the content column. */
export const PANEL_BOTTOM_OFFSET = 60
/** Clearance kept at the top so a grown panel never covers the tab strip. */
export const PANEL_TOP_RESERVE = 48
/** Gap between the content column, a panel, and the next panel over. */
export const PANEL_GAP = 8

/**
 * Git panel width.
 *
 * 440 rather than the historical 320: worktree rows carry a fixed control
 * gutter plus a name that ellipsises, and at 320 the name lost most of its
 * space to the gutter. The extra 120px goes entirely to the name.
 */
export const GIT_PANEL_WIDTH = 440

/**
 * File explorer width.
 *
 * 264 rather than 240: the operator asked for roughly 10% more room for paths
 * that ellipsise in a deep tree.
 *
 * Unlike the git panel this constant is read at exactly ONE site -- the wrapper
 * in `App.tsx` that positions the panel -- because `FileExplorer` itself renders
 * at `width: '100%'` and inherits whatever the wrapper gives it. That is also
 * why the ATV shell can mount the same component at its own dock width.
 */
export const FILE_EXPLORER_WIDTH = 264

/** The panel height with no operator override. Also the FLOOR for a drag. */
export function defaultPanelHeight(expandedUI: boolean): number {
  return (expandedUI ? PANEL_BODY_EXPANDED : PANEL_BODY_DEFAULT) + PANEL_CHROME
}

/**
 * The tallest a panel may grow in the current window.
 *
 * The `max` guarantees a short window never produces a ceiling BELOW the floor,
 * which would make `resolvePanelHeight`'s clamp invert and pin every panel to a
 * few pixels.
 */
export function maxPanelHeight(winHeight: number, defaultHeight: number): number {
  return Math.max(defaultHeight, winHeight - PANEL_BOTTOM_OFFSET - PANEL_TOP_RESERVE)
}

/**
 * Resolve the height a panel actually renders at.
 *
 * Height is always DERIVED, never stored raw and trusted. That single clamp
 * gives all three behaviours the operator asked for: the default is a floor (a
 * drag can never make a panel shorter than it is today), the viewport is a
 * ceiling, and a stale override is lifted automatically when `expandedUI`
 * raises the default underneath it.
 */
export function resolvePanelHeight(
  override: number | null,
  defaultHeight: number,
  winHeight: number,
): number {
  const ceiling = maxPanelHeight(winHeight, defaultHeight)
  return Math.min(ceiling, Math.max(defaultHeight, override ?? defaultHeight))
}
