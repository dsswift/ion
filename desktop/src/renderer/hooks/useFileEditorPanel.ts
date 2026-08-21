import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useEdgeResize, type ResizeGeometry } from './useEdgeResize'
import { zoomDelta, zoomViewport } from '../viewport-zoom'

const MIN_WIDTH = 400
const MIN_HEIGHT = 280

/**
 * Clamp a geometry so it fits within the current viewport: never larger than
 * the viewport, never positioned off-screen. Restored geometry saved on a
 * larger display must be clamped before applying so the editor doesn't render
 * oversized or stranded on a smaller display.
 */
function clampToViewport(geo: ResizeGeometry): ResizeGeometry {
  const viewport = zoomViewport()
  const w = Math.max(MIN_WIDTH, Math.min(geo.w, viewport.width))
  const h = Math.max(MIN_HEIGHT, Math.min(geo.h, viewport.height))
  const x = Math.max(0, Math.min(geo.x, viewport.width - w))
  const y = Math.max(0, Math.min(geo.y, viewport.height - h))
  return { x, y, w, h }
}

interface UseFileEditorPanelResult {
  panelRef: React.RefObject<HTMLDivElement | null>
  posRef: React.MutableRefObject<{ x: number; y: number }>
  size: { w: number; h: number }
  handleDragStart: (e: React.MouseEvent) => void
  /** Renders the 8 edge/corner resize hit zones. */
  renderResizeZones: () => React.ReactElement[]
}

/**
 * Manages the FileEditor panel position and size.
 *
 * Uses refs + direct DOM mutation during drag to avoid re-renders that
 * interfere with framer-motion Reorder layout animations. Geometry is
 * persisted to the session store on drag/resize end.
 */
export function useFileEditorPanel(): UseFileEditorPanelResult {
  const storeGeo = useSessionStore((s) => s.editorGeometry)
  const posRef = useRef({ x: storeGeo.x, y: storeGeo.y })
  const [size, setSize] = useState({ w: storeGeo.w, h: storeGeo.h })
  const sizeRef = useRef({ w: storeGeo.w, h: storeGeo.h })
  const panelRef = useRef<HTMLDivElement>(null)

  // Keep refs in sync when store geometry changes (e.g. restored on startup).
  // Clamp to the viewport first so geometry saved on a larger monitor renders
  // on-screen and correctly sized.
  useEffect(() => {
    const clamped = clampToViewport({ x: storeGeo.x, y: storeGeo.y, w: storeGeo.w, h: storeGeo.h })
    posRef.current = { x: clamped.x, y: clamped.y }
    sizeRef.current = { w: clamped.w, h: clamped.h }
    if (panelRef.current) {
      panelRef.current.style.left = `${clamped.x}px`
      panelRef.current.style.top = `${clamped.y}px`
      panelRef.current.style.width = `${clamped.w}px`
      panelRef.current.style.height = `${clamped.h}px`
    }
    setSize({ w: clamped.w, h: clamped.h })
  }, [storeGeo])

  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: posRef.current.x, originY: posRef.current.y }
  }, [])

  // 8-direction edge/corner resize. onResize mutates DOM directly (to avoid
  // layout thrash mid-drag) AND updates size state; onResizeEnd persists.
  const { renderZones } = useEdgeResize({
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    getGeometry: () => ({ x: posRef.current.x, y: posRef.current.y, w: sizeRef.current.w, h: sizeRef.current.h }),
    onResize: (geo) => {
      posRef.current = { x: geo.x, y: geo.y }
      sizeRef.current = { w: geo.w, h: geo.h }
      if (panelRef.current) {
        panelRef.current.style.left = `${geo.x}px`
        panelRef.current.style.top = `${geo.y}px`
        panelRef.current.style.width = `${geo.w}px`
        panelRef.current.style.height = `${geo.h}px`
      }
      setSize({ w: geo.w, h: geo.h })
    },
    onResizeEnd: (geo) => {
      useSessionStore.getState().setEditorGeometry({ x: geo.x, y: geo.y, w: geo.w, h: geo.h })
    },
  })

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const delta = zoomDelta({
          x: e.clientX - dragRef.current.startX,
          y: e.clientY - dragRef.current.startY,
        })
        const viewport = zoomViewport()
        const newX = Math.max(-200, Math.min(viewport.width - 100, dragRef.current.originX + delta.x))
        const newY = Math.max(0, Math.min(viewport.height - 32, dragRef.current.originY + delta.y))
        posRef.current = { x: newX, y: newY }
        // Direct DOM mutation — no React re-render, no layout thrash
        if (panelRef.current) {
          panelRef.current.style.left = `${newX}px`
          panelRef.current.style.top = `${newY}px`
        }
      }
    }
    const handleMouseUp = () => {
      const didDrag = dragRef.current !== null
      dragRef.current = null
      // Persist geometry to global store on drag end
      if (didDrag) {
        const pos = posRef.current
        const sz = sizeRef.current
        useSessionStore.getState().setEditorGeometry({
          x: pos.x, y: pos.y, w: sz.w, h: sz.h,
        })
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  return { panelRef, posRef, size, handleDragStart, renderResizeZones: renderZones }
}
