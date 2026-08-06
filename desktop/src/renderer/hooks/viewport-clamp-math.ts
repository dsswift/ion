/**
 * Pure viewport-clamp math, factored out of `useViewportClamp.ts` so it can be
 * unit-tested in node without pulling the React / preferences chain (the hook
 * reads the operator's UI zoom from the preferences store, which touches
 * `document` at module load).
 *
 * Same split, and the same reason, as `components/anchored-position.ts`.
 */

/** Clearance kept between a popover and every viewport edge. */
export const MARGIN = 8

/**
 * The correction needed to bring `rect` fully inside a `vw` x `vh` viewport.
 *
 * TWO COORDINATE SPACES ARE IN PLAY, and they are not the same one:
 *
 *  - The MEASUREMENT space is real viewport pixels. `getBoundingClientRect()`
 *    and `window.innerWidth/innerHeight` both report in it, so the overflow
 *    math below is correct as written.
 *  - The APPLICATION space is zoomed CSS pixels. The caller applies the
 *    correction via `el.style.translate`, and a CSS length inside a `zoom`-ed
 *    root (the operator's UI zoom, set on `documentElement` in
 *    `preferences-persist.ts`) is scaled by that zoom before it reaches the
 *    screen.
 *
 * So a delta computed in viewport pixels and written as a CSS length lands
 * `zoom` times too far: at uiZoom 1.5 a 100px correction moved the popover
 * 150px and pushed it off the OPPOSITE edge. Dividing by `zoom` converts the
 * delta into the space it is about to be interpreted in.
 */
export function clampDelta(
  rect: DOMRect,
  vw: number,
  vh: number,
  zoom = 1,
): { dx: number; dy: number } {
  let dx = 0
  let dy = 0
  if (rect.right > vw - MARGIN) dx = vw - MARGIN - rect.right
  if (rect.left + dx < MARGIN) dx = MARGIN - rect.left
  if (rect.bottom > vh - MARGIN) dy = vh - MARGIN - rect.bottom
  if (rect.top + dy < MARGIN) dy = MARGIN - rect.top
  // A zero or negative zoom would be a division blow-up; the store clamps
  // uiZoom to [0.5, 2.0], so this guard only covers a malformed read.
  const scale = zoom > 0 ? zoom : 1
  return { dx: dx / scale, dy: dy / scale }
}
