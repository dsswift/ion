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
 */
import { useLayoutEffect, type RefObject } from 'react'

const MARGIN = 8

export function clampDelta(rect: DOMRect, vw: number, vh: number): { dx: number; dy: number } {
  let dx = 0
  let dy = 0
  if (rect.right > vw - MARGIN) dx = vw - MARGIN - rect.right
  if (rect.left + dx < MARGIN) dx = MARGIN - rect.left
  if (rect.bottom > vh - MARGIN) dy = vh - MARGIN - rect.bottom
  if (rect.top + dy < MARGIN) dy = MARGIN - rect.top
  return { dx, dy }
}

export function useViewportClamp(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const apply = (): void => {
      // Measure without our own correction so repeated clamps don't drift.
      el.style.translate = ''
      const rect = el.getBoundingClientRect()
      const { dx, dy } = clampDelta(rect, window.innerWidth, window.innerHeight)
      if (dx !== 0 || dy !== 0) el.style.translate = `${dx}px ${dy}px`
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [ref, active])
}
