import React, { useCallback, useEffect, useRef } from 'react'
import { zoomDelta, zoomViewport } from '../viewport-zoom'

/**
 * Shared 8-direction edge/corner resize hook for floating panels
 * (preview pop-ups, the file editor, etc.).
 *
 * The consumer owns where geometry lives (React state, a store, or direct
 * DOM mutation via a ref). This hook only computes the new geometry on each
 * mousemove and hands it back through `onResize` (live, per-frame) and
 * `onResizeEnd` (once, on mouseup for persistence).
 *
 * Positioning model: geometry is `{ x, y, w, h }` in viewport pixels, matching
 * a `position: fixed` element with `left/top/width/height`.
 */

/** The eight resize directions: four edges and four corners. */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** A panel geometry rectangle in viewport pixels. */
export interface ResizeGeometry {
  x: number
  y: number
  w: number
  h: number
}

export interface UseEdgeResizeParams {
  /** Minimum allowed width in pixels. */
  minWidth: number
  /** Minimum allowed height in pixels. */
  minHeight: number
  /**
   * Fired on every mousemove during a drag with the freshly-computed,
   * clamped geometry. Consumers apply this live (state or DOM mutation).
   */
  onResize: (geo: ResizeGeometry) => void
  /**
   * Fired once on mouseup with the final geometry. Consumers persist here.
   */
  onResizeEnd: (geo: ResizeGeometry) => void
  /**
   * Reads the panel's current geometry at the moment a drag starts. Called
   * on mousedown so the hook captures an accurate anchor even when the
   * consumer stores geometry outside React state (e.g. in a ref).
   */
  getGeometry: () => ResizeGeometry
}

/** The order the eight zones are rendered/iterated in. */
export const RESIZE_DIRECTIONS: ResizeDirection[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
]

/** Cursor for each direction. */
const CURSOR: Record<ResizeDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

/** Thickness of the edge hit zones. */
const EDGE_THICKNESS = 6
/** Side length of the corner hit zones. */
const CORNER_SIZE = 12
/** Base z-index for edge zones; corners sit one above. */
const EDGE_Z = 1
const CORNER_Z = 2

/**
 * Pure geometry solver — exported so it can be unit-tested without React.
 *
 * Given the geometry at drag start (`start`), the active `direction`, and the
 * mouse delta from the mousedown anchor (`dx`, `dy`), returns the new clamped
 * geometry.
 *
 * The clamp order matters: we first apply the raw direction math, then clamp
 * width/height to `[min, viewport]`, then re-derive the constrained edge so a
 * left/top drag that hits the min-size floor pins x/y instead of letting the
 * panel slide past its anchored opposite edge.
 */
export function computeResizeGeometry(
  start: ResizeGeometry,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number,
  viewportW: number,
  viewportH: number,
): ResizeGeometry {
  let { x, y, w, h } = start

  // 1. Raw direction math relative to the start geometry.
  switch (direction) {
    case 'e':
      w = start.w + dx
      break
    case 'w':
      w = start.w - dx
      x = start.x + dx
      break
    case 's':
      h = start.h + dy
      break
    case 'n':
      h = start.h - dy
      y = start.y + dy
      break
    case 'se':
      w = start.w + dx
      h = start.h + dy
      break
    case 'sw':
      w = start.w - dx
      x = start.x + dx
      h = start.h + dy
      break
    case 'ne':
      w = start.w + dx
      h = start.h - dy
      y = start.y + dy
      break
    case 'nw':
      w = start.w - dx
      x = start.x + dx
      h = start.h - dy
      y = start.y + dy
      break
  }

  // 2. Clamp width/height to [min, viewport].
  w = Math.max(minWidth, Math.min(w, viewportW))
  h = Math.max(minHeight, Math.min(h, viewportH))

  // 3. Pin the anchored edge for left/top drags.
  //
  // When the width hit its floor during a `w`/`nw`/`sw` drag, the right edge
  // (start.x + start.w) is anchored; x must not slide past
  // `start.x + start.w - minWidth`, else the panel would drift right while
  // the user keeps dragging the left edge inward. Recomputing x from the
  // clamped width keeps the anchored (right) edge fixed regardless of clamp.
  const isLeftDrag = direction === 'w' || direction === 'nw' || direction === 'sw'
  if (isLeftDrag) {
    x = start.x + start.w - w
  }
  // Same logic for the top edge on `n`/`ne`/`nw` drags: the bottom edge
  // (start.y + start.h) is anchored.
  const isTopDrag = direction === 'n' || direction === 'ne' || direction === 'nw'
  if (isTopDrag) {
    y = start.y + start.h - h
  }

  // 4. Keep the panel on-screen. For left/top drags x/y were derived from the
  // anchored edge above; clamping here would only fire if the panel started
  // partially off-screen, which is acceptable to correct.
  x = Math.max(0, Math.min(x, viewportW - w))
  y = Math.max(0, Math.min(y, viewportH - h))

  return { x, y, w, h }
}

interface DragState {
  direction: ResizeDirection
  /** Mouse position at mousedown. */
  anchorX: number
  anchorY: number
  /** Panel geometry at mousedown. */
  start: ResizeGeometry
}

export interface EdgeResizeZoneProps {
  onMouseDown: (e: React.MouseEvent) => void
  style: React.CSSProperties
}

export interface UseEdgeResizeResult {
  /** Whether a resize drag is currently active. */
  isResizing: () => boolean
  /** Props ({ onMouseDown, style }) for a single direction's hit zone. */
  getZoneProps: (direction: ResizeDirection) => EdgeResizeZoneProps
  /** All eight hit-zone elements, ready to spread into a relatively/absolutely positioned container. */
  renderZones: () => React.ReactElement[]
}

/**
 * Absolute-position CSS for a direction's hit zone. Edges are thin strips
 * along their side; corners are small squares that sit above the edges so a
 * corner drag wins over the two edges it overlaps.
 */
function zoneLayout(direction: ResizeDirection): React.CSSProperties {
  switch (direction) {
    case 'n':
      return { top: 0, left: 0, right: 0, height: EDGE_THICKNESS, zIndex: EDGE_Z }
    case 's':
      return { bottom: 0, left: 0, right: 0, height: EDGE_THICKNESS, zIndex: EDGE_Z }
    case 'e':
      return { top: 0, right: 0, bottom: 0, width: EDGE_THICKNESS, zIndex: EDGE_Z }
    case 'w':
      return { top: 0, left: 0, bottom: 0, width: EDGE_THICKNESS, zIndex: EDGE_Z }
    case 'ne':
      return { top: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE, zIndex: CORNER_Z }
    case 'nw':
      return { top: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE, zIndex: CORNER_Z }
    case 'se':
      return { bottom: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE, zIndex: CORNER_Z }
    case 'sw':
      return { bottom: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE, zIndex: CORNER_Z }
  }
}

export function useEdgeResize(params: UseEdgeResizeParams): UseEdgeResizeResult {
  const { minWidth, minHeight, onResize, onResizeEnd, getGeometry } = params

  const dragRef = useRef<DragState | null>(null)

  // Keep the latest callbacks/params in refs so the global listeners (attached
  // once) always see current values without re-subscribing every render.
  const cbRef = useRef({ minWidth, minHeight, onResize, onResizeEnd, getGeometry })
  cbRef.current = { minWidth, minHeight, onResize, onResizeEnd, getGeometry }

  const startResize = useCallback((direction: ResizeDirection, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      direction,
      anchorX: e.clientX,
      anchorY: e.clientY,
      start: cbRef.current.getGeometry(),
    }
  }, [])

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const { minWidth: mw, minHeight: mh, onResize: onR } = cbRef.current
      const delta = zoomDelta({ x: e.clientX - drag.anchorX, y: e.clientY - drag.anchorY })
      const viewport = zoomViewport()
      const dx = delta.x
      const dy = delta.y
      const geo = computeResizeGeometry(
        drag.start,
        drag.direction,
        dx,
        dy,
        mw,
        mh,
        viewport.width,
        viewport.height,
      )
      onR(geo)
    }

    const handleUp = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      const { minWidth: mw, minHeight: mh, onResizeEnd: onEnd } = cbRef.current
      const delta = zoomDelta({ x: e.clientX - drag.anchorX, y: e.clientY - drag.anchorY })
      const viewport = zoomViewport()
      const dx = delta.x
      const dy = delta.y
      const geo = computeResizeGeometry(
        drag.start,
        drag.direction,
        dx,
        dy,
        mw,
        mh,
        viewport.width,
        viewport.height,
      )
      onEnd(geo)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  const getZoneProps = useCallback((direction: ResizeDirection): EdgeResizeZoneProps => {
    return {
      onMouseDown: (e: React.MouseEvent) => startResize(direction, e),
      style: {
        position: 'absolute',
        cursor: CURSOR[direction],
        ...zoneLayout(direction),
      },
    }
  }, [startResize])

  const renderZones = useCallback((): React.ReactElement[] => {
    return RESIZE_DIRECTIONS.map((direction) => {
      const props = getZoneProps(direction)
      return React.createElement('div', {
        key: `resize-${direction}`,
        'data-ion-ui': true,
        'data-resize-zone': direction,
        onMouseDown: props.onMouseDown,
        style: props.style,
      })
    })
  }, [getZoneProps])

  const isResizing = useCallback(() => dragRef.current !== null, [])

  return { isResizing, getZoneProps, renderZones }
}
