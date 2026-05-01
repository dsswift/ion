import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'

const MIN_WIDTH = 400
const MIN_HEIGHT = 280

interface UseFileEditorPanelResult {
  panelRef: React.RefObject<HTMLDivElement | null>
  posRef: React.MutableRefObject<{ x: number; y: number }>
  size: { w: number; h: number }
  handleDragStart: (e: React.MouseEvent) => void
  handleResizeStart: (e: React.MouseEvent) => void
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

  // Keep refs in sync when store geometry changes (e.g. restored on startup)
  useEffect(() => {
    posRef.current = { x: storeGeo.x, y: storeGeo.y }
    sizeRef.current = { w: storeGeo.w, h: storeGeo.h }
    if (panelRef.current) {
      panelRef.current.style.left = `${storeGeo.x}px`
      panelRef.current.style.top = `${storeGeo.y}px`
    }
    setSize({ w: storeGeo.w, h: storeGeo.h })
  }, [storeGeo])

  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: posRef.current.x, originY: posRef.current.y }
  }, [])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: size.w, originH: size.h }
  }, [size])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX
        const dy = e.clientY - dragRef.current.startY
        const newX = Math.max(-200, Math.min(window.innerWidth - 100, dragRef.current.originX + dx))
        const newY = Math.max(0, Math.min(window.innerHeight - 32, dragRef.current.originY + dy))
        posRef.current = { x: newX, y: newY }
        // Direct DOM mutation — no React re-render, no layout thrash
        if (panelRef.current) {
          panelRef.current.style.left = `${newX}px`
          panelRef.current.style.top = `${newY}px`
        }
      }
      if (resizeRef.current) {
        const dx = e.clientX - resizeRef.current.startX
        const dy = e.clientY - resizeRef.current.startY
        const newW = Math.max(MIN_WIDTH, resizeRef.current.originW + dx)
        const newH = Math.max(MIN_HEIGHT, resizeRef.current.originH + dy)
        sizeRef.current = { w: newW, h: newH }
        setSize({ w: newW, h: newH })
      }
    }
    const handleMouseUp = () => {
      const didDrag = dragRef.current !== null
      const didResize = resizeRef.current !== null
      dragRef.current = null
      resizeRef.current = null
      // Persist geometry to global store on drag/resize end
      if (didDrag || didResize) {
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

  return { panelRef, posRef, size, handleDragStart, handleResizeStart }
}
