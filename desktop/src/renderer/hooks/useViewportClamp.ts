/**
 * useViewportClamp — keeps a portaled popover inside the window bounds.
 *
 * Popovers across the app compute anchor positions assuming the overlay's
 * geometry (TabStrip at the bottom of a full-screen glass). The ATV shell
 * renders the same components in a normal window where the strip sits at
 * the TOP — anchor math that opens "above" flies off-screen. Rather than
 * forking per-component positioning, this hook measures the rendered
 * element after layout and nudges it back into the viewport via the CSS
 * `translate` property (which composes with — and never fights — Framer
 * Motion's `transform`).
 *
 * Attach to the popover's root element and pass `active` (open state).
 * Re-clamps on open, on resize, and on content growth (ResizeObserver).
 *
 * This is the primitive for EDGE-anchored popovers — the ones whose style
 * computes `bottom:` / `right:` from a trigger rect so they grow upward or
 * leftward out of the input pill. Popovers anchored to a POINT (a click
 * coordinate, or "below this trigger") use `useAnchoredPopover` instead,
 * which measures and places before paint. See desktop/AGENTS.md
 * § "Popover positioning".
 *
 * The clamp math lives in `viewport-clamp-math.ts` so it can be unit-tested
 * in node; this file is the React/preferences-bound wrapper.
 */
import { useLayoutEffect, type RefObject } from 'react'
import { usePreferencesStore } from '../preferences'
import { clampDelta } from './viewport-clamp-math'

export { clampDelta, MARGIN } from './viewport-clamp-math'

/** How long to keep re-clamping after open — covers entrance animations. */
const SETTLE_MS = 400

export function useViewportClamp(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const apply = (): void => {
      // Measure without our own correction so repeated clamps don't drift.
      el.style.translate = ''
      const rect = el.getBoundingClientRect()
      // Read the zoom at apply time, not at mount: the operator can change it
      // while a popover is open, and the resize listener below re-runs this.
      const zoom = usePreferencesStore.getState().uiZoom
      const { dx, dy } = clampDelta(rect, window.innerWidth, window.innerHeight, zoom)
      if (dx !== 0 || dy !== 0) el.style.translate = `${dx}px ${dy}px`
    }
    apply()
    // Entrance-animation settle: Framer's scale/slide entrances are JS-driven
    // transforms, so the first measurement sees the mid-animation rect (a
    // scale-0.9 popover measures ~10% small) and the correction undershoots —
    // and the ResizeObserver never refires because the LAYOUT size never
    // changed, only the transform. That left tall pickers with their top edge
    // cut off at the window border. Re-clamp on animation frames until the
    // entrance settles, then the observer + resize listener take over.
    const startedAt = performance.now()
    let raf = requestAnimationFrame(function settle() {
      apply()
      if (performance.now() - startedAt < SETTLE_MS) raf = requestAnimationFrame(settle)
    })
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [ref, active])
}
