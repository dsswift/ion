/**
 * Pure positioning math for anchored popovers, factored out of
 * `TabStripShared.ts` so it can be unit-tested in node without
 * pulling the React / theme / preferences chain (those depend on
 * `document` at module load).
 *
 * The runtime wrapper lives in `TabStripShared.ts` as
 * `useAnchoredPopoverPosition` and uses this function after
 * measuring the popover's bounding rect.
 */

/** Inputs for the positioning math. All measurements are in
 *  zoom-adjusted coordinate space (same space `zoomRect` /
 *  `zoomViewport` return at runtime). */
export interface AnchoredPositionInput {
  /** The click/hover anchor (top-left of the popover when not flipping). */
  anchor: { x: number; y: number }
  /** Measured popover size after mount. */
  menu: { width: number; height: number }
  /** Viewport in zoom-adjusted coordinates. */
  viewport: { width: number; height: number }
  /** Vertical offset from the anchor when opening downward. */
  offsetY: number
  /** Horizontal offset from the anchor / parent row when opening "rightOf". */
  offsetX: number
  /** Safety margin to keep between the popover and every viewport edge. */
  margin: number
  /**
   * For top-level popovers (`'below'`), the menu opens below
   * `anchor.y + offsetY` and flips up to `anchor.y - menuHeight - offsetY`
   * if the bottom would overflow.
   *
   * For submenus (`'rightOf'`), the menu opens to the right of
   * `parentRect.right + offsetX` and flips to the left of
   * `parentRect.left - menuWidth - offsetX` if the right side would
   * overflow. Vertically it still prefers "below `anchor.y`" with the
   * same flip-up fallback so a submenu can choose its vertical
   * placement independently of the parent row.
   */
  prefer: 'below' | 'rightOf'
  /**
   * The parent row's bounding rect, only used when `prefer === 'rightOf'`.
   * Needed because the right-flip target is `parentRect.left -
   * menuWidth`, which can't be derived from the anchor alone. When
   * omitted, the submenu flips relative to `anchor.x` instead, which
   * is a safe fallback but produces a small visual jump because the
   * right and left of a wide parent row are not the same x.
   */
  parentRect?: { left: number; right: number; top: number; bottom: number }
}

/** Pure positioning math: given a measured menu and a viewport,
 *  return the on-screen `{left, top}` for the popover.
 *
 * Strategy per axis:
 *
 *  - Vertical: prefer opening below the anchor. If that overflows,
 *    flip up. If the flip-up would also overflow (menu taller than
 *    viewport), clamp to `margin` from the top.
 *  - Horizontal: for `'below'`, prefer `anchor.x`. Clamp to keep the
 *    right edge inside the viewport. For `'rightOf'`, prefer right of
 *    the parent row (or anchor). If that overflows, flip to the left
 *    of the parent row (or anchor).
 *  - Both axes finally clamp to `[margin, viewport - menu - margin]`
 *    so an oversized menu still lands somewhere reachable; consumers
 *    pair this with `maxHeight: viewport - 2 * margin` + `overflowY:
 *    auto` to keep an oversized menu scrollable.
 */
export function computeAnchoredPosition(input: AnchoredPositionInput): { left: number; top: number } {
  const { anchor, menu, viewport, offsetY, offsetX, margin, prefer, parentRect } = input

  // ── Vertical ──
  // Default: open downward at anchor.y (+ offsetY for 'below').
  const downTop = anchor.y + (prefer === 'below' ? offsetY : 0)
  const downBottom = downTop + menu.height + margin
  let top: number
  if (downBottom <= viewport.height) {
    // Fits below.
    top = downTop
  } else {
    // Flip up: open above the anchor.
    const upTop = anchor.y - menu.height - (prefer === 'below' ? offsetY : 0)
    if (upTop >= margin) {
      top = upTop
    } else {
      // Neither fits — menu is taller than the available space. Pin
      // to top margin and let the caller's overflowY:auto save us.
      top = margin
    }
  }
  // Final clamp for robustness against rounding / odd anchors.
  top = Math.max(margin, Math.min(top, viewport.height - menu.height - margin))
  // If even the clamp would push it negative (menu > viewport), pin
  // to top margin.
  if (top < margin) top = margin

  // ── Horizontal ──
  let left: number
  if (prefer === 'below') {
    // Top-level menu: anchor at anchor.x, clamp right edge.
    left = Math.min(anchor.x, viewport.width - menu.width - margin)
  } else {
    // Submenu: prefer right of the parent row (or anchor as fallback).
    const parentLeft = parentRect ? parentRect.left : anchor.x
    const rightTarget = anchor.x + offsetX
    if (rightTarget + menu.width + margin <= viewport.width) {
      left = rightTarget
    } else {
      // Flip to the left of the parent row.
      left = parentLeft - menu.width - offsetX
    }
  }
  left = Math.max(margin, Math.min(left, viewport.width - menu.width - margin))
  if (left < margin) left = margin

  return { left, top }
}
