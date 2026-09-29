import { usePreferencesStore } from './preferences'

function zoomFactor(): number {
  const store = usePreferencesStore as unknown as { getState?: () => { uiZoom?: unknown } }
  const zoom = store.getState?.().uiZoom
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/** Convert a viewport-space pointer point to CSS coordinates under root zoom. */
export function zoomPoint(point: { x: number; y: number }): { x: number; y: number } {
  const zoom = zoomFactor()
  return { x: point.x / zoom, y: point.y / zoom }
}

/** Convert a viewport-space pointer delta to CSS coordinates under root zoom. */
export function zoomDelta(delta: { x: number; y: number }): { x: number; y: number } {
  return zoomPoint(delta)
}

/** Convert a viewport DOMRect to CSS coordinates for fixed positioning. */
export function zoomRect(rect: DOMRect): DOMRect {
  const zoom = zoomFactor()
  if (zoom === 1) return rect
  return new DOMRect(rect.x / zoom, rect.y / zoom, rect.width / zoom, rect.height / zoom)
}

/** Return viewport dimensions in CSS coordinates under root zoom. */
export function zoomViewport(): { width: number; height: number } {
  const zoom = zoomFactor()
  return { width: window.innerWidth / zoom, height: window.innerHeight / zoom }
}

/** Where a trigger sits, in the CSS lengths a `position: fixed` popover needs. */
export interface ZoomAnchorEdges {
  left: number
  top: number
  bottom: number
  centerX: number
  /** CSS `bottom` that puts a popover's bottom edge on the trigger's top edge. */
  fromBottom: number
  /** CSS `right` that puts a popover's right edge on the trigger's right edge. */
  fromRight: number
  viewport: { width: number; height: number }
}

/**
 * Convert a trigger's viewport DOMRect into the CSS offsets an edge-anchored
 * popover floats from. A raw `window.innerHeight - rect.top` is in viewport
 * pixels; used as a CSS `bottom` it is multiplied by the root zoom again, so
 * the popover drifts away from its trigger at any zoom other than 1.
 */
export function zoomAnchorEdges(rect: DOMRect): ZoomAnchorEdges {
  const r = zoomRect(rect)
  const viewport = zoomViewport()
  return {
    left: r.left,
    top: r.top,
    bottom: r.bottom,
    centerX: r.left + r.width / 2,
    fromBottom: viewport.height - r.top,
    fromRight: viewport.width - r.right,
    viewport,
  }
}
