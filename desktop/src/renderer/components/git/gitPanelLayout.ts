/**
 * Git-panel vertical layout arithmetic.
 *
 * The panel is a fixed-width, bottom-anchored column of five stacked sections:
 * panel header, Changes, Worktrees, Integration, Graph. Changes and Graph share
 * one resizable pool (the "split pool") governed by a drag divider; Worktrees
 * and Integration are fixed-height sections outside that pool.
 *
 * ── Why this is a pure module ───────────────────────────────────────────────
 * The arithmetic used to live inline in `GitPanel.tsx`, where it could only be
 * verified by eye. Two invariants that matter are not visible on read:
 *
 *   1. Conservation: every pixel of the panel's height is assigned to a
 *      section. Slack left unassigned in a flex column is silently absorbed by
 *      whichever child has `flex: 1` -- which produced a dead, unusable band at
 *      the bottom of the panel whenever both Changes and Graph were collapsed.
 *   2. Shrink-wrap: when both split sections are collapsed there is no pool to
 *      distribute, so the panel's natural height drops to chrome plus the fixed
 *      bodies. Because the panel is bottom-anchored, a shorter panel reads as
 *      the content moving down to fill the space rather than a void opening up.
 *
 * Both are asserted in `gitPanelLayout.test.ts` across every open/closed
 * permutation. `height` is the authoritative output: the caller applies it as
 * `maxHeight` and lets the flex column shrink-wrap, and no child may carry
 * `flex: 1`, or invariant 1 is defeated at the DOM level.
 */

/** Panel title row (close button, repo name, refresh). */
export const PANEL_HEADER = 28
/** Each section's clickable header row. All five are the same height. */
export const SECTION_HEADER = 28
/** Drag divider between Changes and Graph. Present only when both are open. */
export const DIVIDER = 6

export const WORKTREES_HEADER = SECTION_HEADER
export const WORKTREES_BODY_MAX = 132
export const INTEGRATION_HEADER = SECTION_HEADER
export const INTEGRATION_BODY_MAX = 148

export interface GitPanelLayoutInput {
  /**
   * Ceiling for the panel's height -- the height it occupies when at least one
   * split section is open. Derived by the caller from the conversation card so
   * the two top edges align.
   */
  maxHeight: number
  changesOpen: boolean
  graphOpen: boolean
  worktreesOpen: boolean
  integrationOpen: boolean
  /** Fraction of the split pool given to Changes when both split sections are open. */
  splitRatio: number
  /**
   * The panel is showing an integration bench.
   *
   * A bench is rebuildable: its branch is recreated from the source branch plus
   * each member's pinned commit on every rebuild. So it must never hold
   * uncommitted changes (they are destroyed by the next rebuild) and its
   * history is synthetic (one merge per member, recreated each time). Changes
   * and Graph are therefore not merely collapsed but ABSENT, and the freed
   * space belongs to Worktrees and Integration.
   *
   * Distinct from `changesOpen: false, graphOpen: false`, which is a collapse
   * the operator can undo. In bench mode there is nothing to expand.
   */
  benchMode?: boolean
}

export interface GitPanelLayout {
  /** Panel header + all five section headers + divider when visible. */
  chrome: number
  /** Height of the Changes body, 0 when collapsed. */
  changesBody: number
  /** Height of the Graph body, 0 when collapsed. */
  graphBody: number
  /** Height of the Worktrees body, 0 when collapsed. */
  worktreesBody: number
  /** Height of the Integration body, 0 when collapsed. */
  integrationBody: number
  /** Pool shared by Changes and Graph. 0 when both are collapsed. */
  splitPool: number
  /** Whether the drag divider occupies a row. */
  dividerVisible: boolean
  /**
   * Everything that is NOT the split pool: chrome plus the Worktrees and
   * Integration bodies. This is the value the drag hook needs to convert a
   * cursor delta into a ratio delta -- passing bare chrome overstates the pool
   * by up to both fixed bodies and makes the divider lag the cursor.
   */
  nonSplitTotal: number
  /**
   * The panel's natural height: the sum of every section. Equals `maxHeight`
   * while either split section is open, and shrinks to `nonSplitTotal` when
   * both are collapsed.
   */
  height: number
}

/**
 * Compute every vertical dimension of the git panel.
 *
 * Distribution rules:
 * - Both split sections open: the pool is divided by `splitRatio`, and the
 *   divider consumes a row of chrome (which is why the divider is counted in
 *   `chrome` here rather than reclaimed by hand in the single-open branches).
 * - Exactly one open: it takes the entire pool. No divider row exists, so the
 *   pool is 6px larger than in the both-open case -- structurally, not by a
 *   hand-added constant.
 * - Neither open: there is no pool. The panel shrink-wraps to `nonSplitTotal`.
 */
export function computeGitPanelLayout(input: GitPanelLayoutInput): GitPanelLayout {
  const { maxHeight, worktreesOpen, integrationOpen, splitRatio, benchMode } = input

  // In a bench the split sections do not exist, so neither their headers nor
  // their bodies nor the divider occupy any space. Forcing the flags here (as
  // opposed to hiding the sections only in the JSX) is what keeps the arithmetic
  // and the DOM in agreement: chrome counts two fewer headers, and the
  // conservation invariant still holds.
  const changesOpen = benchMode ? false : input.changesOpen
  const graphOpen = benchMode ? false : input.graphOpen

  const bothSplitOpen = changesOpen && graphOpen
  const dividerVisible = bothSplitOpen

  const chrome =
    PANEL_HEADER +
    // Changes, Worktrees, Integration, Graph — minus Changes and Graph in a
    // bench, where those sections are not rendered at all.
    SECTION_HEADER * (benchMode ? 2 : 4) +
    (dividerVisible ? DIVIDER : 0)

  const worktreesBody = worktreesOpen ? WORKTREES_BODY_MAX : 0
  const integrationBody = integrationOpen ? INTEGRATION_BODY_MAX : 0
  const nonSplitTotal = chrome + worktreesBody + integrationBody

  // A maxHeight smaller than the chrome plus the fixed bodies must not produce
  // negative body heights; the pool simply collapses to zero and the fixed
  // sections overflow the ceiling (they are the operator's explicit choice).
  const splitPool = (changesOpen || graphOpen)
    ? Math.max(0, maxHeight - nonSplitTotal)
    : 0

  let changesBody = 0
  let graphBody = 0
  if (bothSplitOpen) {
    changesBody = Math.round(splitPool * splitRatio)
    graphBody = splitPool - changesBody
  } else if (changesOpen) {
    changesBody = splitPool
  } else if (graphOpen) {
    graphBody = splitPool
  }

  return {
    chrome,
    changesBody,
    graphBody,
    worktreesBody,
    integrationBody,
    splitPool,
    dividerVisible,
    nonSplitTotal,
    height: nonSplitTotal + changesBody + graphBody,
  }
}
