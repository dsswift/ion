/**
 * useAnchoredPopover — the canonical positioner for every POINT-anchored
 * popover in the renderer.
 *
 * A point-anchored popover is one placed at a coordinate: the click position a
 * context menu opens at, or "below this trigger" for a dropdown. Anything with
 * an `anchor: { x, y }` prop is in this family. (A popover that instead
 * computes `bottom:` / `right:` from a trigger rect so it grows upward out of
 * the input pill is EDGE-anchored, and uses `useViewportClamp`. See
 * desktop/AGENTS.md § "Popover positioning".)
 *
 * The naive "open downward at the click point" math fails in two ways:
 *
 *   1. When the window is short and the menu is tall (a manual tab-group with
 *      many target groups, a worktree row menu right-clicked near the bottom
 *      of the git panel) the bottom of the popup falls off-screen and items
 *      become un-clickable.
 *   2. Submenus depending on a parent-row anchor inherit the same problem and
 *      can overflow to the right of a narrow window.
 *
 * This hook measures the popover after mount (via `useLayoutEffect`, so it
 * runs before paint and the corrected position is never visible as a jump),
 * then picks an on-screen position that prefers the natural anchor placement
 * but flips/clamps when the menu would overflow the viewport. The decision
 * math is factored out into `computeAnchoredPosition`
 * (components/anchored-position.ts) so it can be unit-tested without a DOM.
 *
 * Measuring is the point. A guessed height (`items.length * 28`, a hardcoded
 * 300) is not a substitute: it drifts the moment an item is added, a label
 * wraps, or the font size changes, and the drift is invisible until a menu
 * hangs off the screen edge again.
 *
 * IMPORTANT: callers must pass any state that changes the rendered menu height
 * (e.g. `showNewGroupInput`, an inline rename panel, an open child submenu) in
 * the `deps` array so the hook re-measures and repositions after the menu
 * grows or shrinks. Failing to do so causes the menu to stay anchored at its
 * first-measured size and re-overflow when its content expands.
 */
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { computeAnchoredPosition } from '../components/anchored-position'
import { zoomRect, zoomViewport } from '../viewport-zoom'

/** Options accepted by `useAnchoredPopover`. */
export interface UseAnchoredPopoverOpts {
  /** Vertical offset from the anchor when opening downward. Default 8 ('below') / 0 ('rightOf'). */
  offsetY?: number
  /** Horizontal offset between a submenu and its parent row's right edge. Default 8. */
  offsetX?: number
  /** Margin between the popover and the viewport edge. Default 8. */
  margin?: number
  /** Anchor strategy — see `AnchoredPositionInput.prefer`. Default 'below'. */
  prefer?: 'below' | 'rightOf'
  /** Parent row rect — required for clean left-flip when `prefer === 'rightOf'`. */
  parentRect?: { left: number; right: number; top: number; bottom: number }
  /** Extra dependencies that should trigger a re-measure (e.g. open submenu state, inline input toggles). */
  deps?: ReadonlyArray<unknown>
}

/** Result of the positioning hook. `ready` is false on the first
 *  render (before measurement); consumers should keep the popover
 *  `visibility: hidden` until ready to avoid a one-frame flash at the
 *  unmeasured anchor position. */
export interface UseAnchoredPopoverResult {
  /** Attach to the popover root so the hook can measure its size. */
  ref: React.RefCallback<HTMLElement>
  /** On-screen left in zoom-adjusted coordinates. */
  left: number
  /** On-screen top in zoom-adjusted coordinates. */
  top: number
  /** True once the popover has been measured at least once. */
  ready: boolean
}

/**
 * Position an anchored popover on-screen, measuring its size after
 * mount so the placement adapts to actual rendered height (rather
 * than guessing from item count).
 *
 * Usage:
 *
 *   const pos = useAnchoredPopover(
 *     anchor,
 *     { prefer: 'below', deps: [moveSubmenu, showNewGroupInput] },
 *   )
 *   return <div
 *     ref={pos.ref}
 *     style={{
 *       position: 'fixed',
 *       left: pos.left,
 *       top: pos.top,
 *       visibility: pos.ready ? 'visible' : 'hidden',
 *       maxHeight: `calc(100vh - 16px)`,
 *       overflowY: 'auto',
 *     }}
 *   >…</div>
 *
 * The `deps` array must include any state that changes menu height
 * (open submenus, inline inputs); otherwise the menu sticks at its
 * first-measured size and re-overflows on expansion.
 */
export function useAnchoredPopover(
  anchor: { x: number; y: number },
  opts: UseAnchoredPopoverOpts = {},
): UseAnchoredPopoverResult {
  const prefer = opts.prefer ?? 'below'
  const offsetY = opts.offsetY ?? (prefer === 'below' ? 8 : 0)
  const offsetX = opts.offsetX ?? 8
  const margin = opts.margin ?? 8
  const parentRect = opts.parentRect
  const deps = opts.deps ?? []

  const elRef = useRef<HTMLElement | null>(null)
  // Bumped whenever the measured node changes identity — including the very
  // first attach. Without it, a popover whose node arrives on a LATER render
  // than the hook's first run is never measured: the layout effect below fires
  // once with `elRef.current === null`, bails, and never re-runs because its
  // deps did not change. That happens whenever the portal target resolves late
  // (PopoverLayer publishes its element through state, so a menu mounted in the
  // same commit as the provider renders `null` on its first pass), and it would
  // leave the menu pinned at the unmeasured anchor — exactly the off-screen
  // placement this hook exists to prevent.
  const [nodeVersion, setNodeVersion] = useState(0)
  // Seed with the natural anchor placement so the first paint (before
  // measurement) lands roughly where the user clicked. The popover is
  // rendered with `visibility: hidden` until `ready` flips true on
  // the same frame, so this default is mostly a fallback for
  // consumers that don't gate on `ready`.
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>(() => ({
    left: anchor.x,
    top: anchor.y + (prefer === 'below' ? offsetY : 0),
    ready: false,
  }))

  // Measure-and-place runs synchronously after every render that
  // could change the menu's size or anchor. `useLayoutEffect` runs
  // before the browser paints, so the re-render with the corrected
  // position is invisible to the user.
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const rect = zoomRect(el.getBoundingClientRect())
    const viewport = zoomViewport()
    const next = computeAnchoredPosition({
      anchor,
      menu: { width: rect.width, height: rect.height },
      viewport,
      offsetY,
      offsetX,
      margin,
      prefer,
      parentRect,
    })
    setPos((prev) => {
      // Skip the state update when nothing meaningful changed so we
      // don't trigger an endless re-render loop (the layout effect
      // re-runs on every render that changes the deps, but its
      // measurement is stable once the menu is laid out).
      if (prev.ready && prev.left === next.left && prev.top === next.top) return prev
      return { left: next.left, top: next.top, ready: true }
    })
    // We intentionally include `anchor.x` / `anchor.y` rather than the
    // object identity so a parent that reconstructs `anchor` each
    // render doesn't cause a measurement storm. `parentRect` is
    // similarly destructured. The spread `...deps` is intentional —
    // callers pass additional dependencies that are statically unknown
    // here; the spread is the correct mechanism for that pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    anchor.x,
    anchor.y,
    offsetY,
    offsetX,
    margin,
    prefer,
    parentRect?.left,
    parentRect?.right,
    parentRect?.top,
    parentRect?.bottom,
    // Re-measure when the node itself attaches or is swapped.
    nodeVersion,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ...deps,
  ])

  // Re-measure on viewport changes — a window resize can flip a
  // previously-fits-below menu into needing to flip up.
  useLayoutEffect(() => {
    const onResize = () => {
      const el = elRef.current
      if (!el) return
      const rect = zoomRect(el.getBoundingClientRect())
      const viewport = zoomViewport()
      const next = computeAnchoredPosition({
        anchor,
        menu: { width: rect.width, height: rect.height },
        viewport,
        offsetY,
        offsetX,
        margin,
        prefer,
        parentRect,
      })
      setPos({ left: next.left, top: next.top, ready: true })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, offsetY, offsetX, margin, prefer, parentRect?.left, parentRect?.right, parentRect?.top, parentRect?.bottom])

  const refCallback = useCallback<React.RefCallback<HTMLElement>>((node) => {
    // Ignore detaches and keep the last node. React re-runs an INLINE ref
    // callback on every render — detaching with `null` and immediately
    // re-attaching the same element — and several callers compose this ref
    // with their own inside an inline arrow. Bumping on each of those attaches
    // would schedule a state update per render and blow the update depth.
    if (!node || elRef.current === node) return
    elRef.current = node
    setNodeVersion((v) => v + 1)
  }, [])

  return { ref: refCallback, left: pos.left, top: pos.top, ready: pos.ready }
}
