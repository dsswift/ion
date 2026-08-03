/**
 * Zoom-adjusted geometry helpers.
 *
 * The operator's UI zoom is applied as `document.documentElement.style.zoom`
 * (preferences-persist.ts). That creates two coordinate spaces: DOM
 * measurements come back in real viewport pixels, while CSS lengths written
 * into a `position: fixed` style are interpreted in the zoomed space. Anything
 * that measures an element and then positions another element from that
 * measurement has to convert, or the placement is off by the zoom factor.
 *
 * These two helpers are that conversion, and they live here — not in a
 * tab-strip module — because every popover in the renderer needs them.
 */
import { usePreferencesStore } from './preferences'

/** Adjust viewport rect to zoomed coordinate space for fixed positioning.
 * getBoundingClientRect() returns viewport pixels, but position:fixed inside
 * a CSS-zoomed root interprets coordinates in the zoomed space. Dividing by
 * zoom cancels the double-scaling. */
export function zoomRect(rect: DOMRect): DOMRect {
  const z = usePreferencesStore.getState().uiZoom
  if (z === 1) return rect
  return new DOMRect(rect.x / z, rect.y / z, rect.width / z, rect.height / z)
}

/** Return viewport dimensions in zoom-adjusted coordinate space. */
export function zoomViewport(): { width: number; height: number } {
  const z = usePreferencesStore.getState().uiZoom
  return { width: window.innerWidth / z, height: window.innerHeight / z }
}
