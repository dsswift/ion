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
