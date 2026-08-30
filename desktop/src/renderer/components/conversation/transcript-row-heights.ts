/**
 * Estimated transcript row heights for the virtualizer.
 *
 * A leaf module with no imports so tests can assert the relationship between
 * these numbers without pulling in the theme (and therefore a DOM) through
 * TranscriptRows.
 *
 * ── Why a chart row needs its own estimate ──────────────────────────────────
 * `scrollToIndex` computes its target offset from ESTIMATES. Every row above
 * the target that later measures taller produces a scroll adjustment, and the
 * viewport walks away from where the jump put it. A chart card is roughly five
 * times a text row, so a single flat estimate made a jump to a chart drift far
 * enough to look like nothing had happened at all.
 */

/** A text, tool, or assistant row. */
export const ESTIMATED_ROW_HEIGHT = 72

/**
 * A row that renders a chart card: a fixed 260px plot (ChartOutputCard's
 * CHART_HEIGHT) plus title, caption, and the value table beneath it.
 */
export const ESTIMATED_CHART_ROW_HEIGHT = 380
