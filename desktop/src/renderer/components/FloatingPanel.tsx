import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { useEdgeResize } from '../hooks/useEdgeResize'

/**
 * Clamp a geometry so it fits within the current viewport: never larger than
 * the viewport, never positioned off-screen. Used on mount/restore so a panel
 * saved on a large monitor doesn't render oversized or stranded on a laptop.
 */
function clampToViewport(
  geo: { x: number; y: number; w: number; h: number },
  minWidth: number,
  minHeight: number,
): { x: number; y: number; w: number; h: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(minWidth, Math.min(geo.w, vw))
  const h = Math.max(minHeight, Math.min(geo.h, vh))
  const x = Math.max(0, Math.min(geo.x, vw - w))
  const y = Math.max(0, Math.min(geo.y, vh - h))
  return { x, y, w, h }
}

interface FloatingPanelProps {
  title: string
  onClose: () => void
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  initialPos?: { x: number; y: number }
  initialSize?: { w: number; h: number }
  onGeometryChange?: (geo: { x: number; y: number; w: number; h: number }) => void
  filePath?: string
  workingDir?: string
  children: React.ReactNode
}

export function FloatingPanel({
  title,
  onClose,
  defaultWidth = 680,
  defaultHeight = 420,
  minWidth = 280,
  minHeight = 180,
  initialPos,
  initialSize,
  onGeometryChange,
  filePath,
  workingDir,
  children,
}: FloatingPanelProps) {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const previewFontSize = usePreferencesStore((s) => s.previewFontSize)
  const incOpenFloatingPanelCount = useSessionStore((s) => s.incOpenFloatingPanelCount)
  const decOpenFloatingPanelCount = useSessionStore((s) => s.decOpenFloatingPanelCount)

  // Track this panel's open state for the zoom-target detection.
  // isPreviewZoomTarget() in useKeyboardShortcuts reads openFloatingPanelCount > 0.
  useEffect(() => {
    incOpenFloatingPanelCount()
    return () => decOpenFloatingPanelCount()
  }, [incOpenFloatingPanelCount, decOpenFloatingPanelCount])

  // Position: start offset toward the left so it doesn't cover the main conversation column
  const [pos, setPos] = useState(initialPos ?? { x: 60, y: 80 })
  const [size, setSize] = useState(initialSize ?? { w: defaultWidth, h: defaultHeight })
  const [titleCtxMenu, setTitleCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Drag state (header move only; resize handled by useEdgeResize below)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  // Track latest pos/size for geometry callback
  const posRef = useRef(pos)
  const sizeRef = useRef(size)
  posRef.current = pos
  sizeRef.current = size

  // Clamp the initial geometry to the viewport once on mount so a panel
  // restored from a larger display renders on-screen and correctly sized.
  useEffect(() => {
    const clamped = clampToViewport({ ...posRef.current, ...sizeRef.current }, minWidth, minHeight)
    setPos({ x: clamped.x, y: clamped.y })
    setSize({ w: clamped.w, h: clamped.h })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only drag from header (left button)
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
  }, [pos])

  // 8-direction edge/corner resize. onResize applies geometry live; onResizeEnd
  // persists via the existing onGeometryChange callback.
  const { renderZones } = useEdgeResize({
    minWidth,
    minHeight,
    getGeometry: () => ({ ...posRef.current, ...sizeRef.current }),
    onResize: (geo) => {
      setSize({ w: geo.w, h: geo.h })
      setPos({ x: geo.x, y: geo.y })
    },
    onResizeEnd: (geo) => {
      if (onGeometryChange) onGeometryChange(geo)
    },
  })

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX
        const dy = e.clientY - dragRef.current.startY
        // Clamp so the header bar (top 32px) always stays within the viewport
        const newX = Math.max(-200, Math.min(window.innerWidth - 100, dragRef.current.originX + dx))
        const newY = Math.max(0, Math.min(window.innerHeight - 32, dragRef.current.originY + dy))
        setPos({ x: newX, y: newY })
      }
    }
    const handleMouseUp = () => {
      const wasDragging = dragRef.current !== null
      dragRef.current = null
      if (wasDragging && onGeometryChange) {
        onGeometryChange({ ...posRef.current, ...sizeRef.current })
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [onGeometryChange])

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Close title context menu on click-outside or Escape
  useEffect(() => {
    if (!titleCtxMenu) return
    const handleClickOutside = () => setTitleCtxMenu(null)
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setTitleCtxMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape, true)
    }
  }, [titleCtxMenu])

  if (!popoverLayer) return null

  const panel = (
    <motion.div
      data-ion-ui
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="glass-surface rounded-xl"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        display: 'flex',
        flexDirection: 'column',
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        boxShadow: '0 16px 48px rgba(0, 0, 0, 0.4)',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 10000,
      }}
    >
      {/* Draggable header */}
      <div
        data-ion-ui
        className="flex items-center justify-between px-3 py-2"
        style={{
          borderBottom: `1px solid ${colors.containerBorder}`,
          background: colors.surfacePrimary,
          cursor: 'grab',
          userSelect: 'none',
        }}
        onMouseDown={handleDragStart}
      >
        <button
          onClick={onClose}
          className="flex-shrink-0 p-0.5 rounded transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <X size={12} />
        </button>
        <span
          className="text-[11px] truncate"
          style={{ color: colors.textSecondary, fontFamily: 'monospace' }}
          onContextMenu={(e) => {
            if (!filePath) return
            e.preventDefault()
            e.stopPropagation()
            setTitleCtxMenu({ x: e.clientX, y: e.clientY })
          }}
          onMouseDown={(e) => {
            if (e.button === 2) e.stopPropagation()
          }}
        >
          {title}
        </span>
      </div>

      {/* Content area — apply preview font-size variable here only (not on
          header/chrome). Pop-up content bodies read var(--ion-conv-font-size)
          so they scale with previewFontSize while buttons/headers stay fixed. */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', ['--ion-conv-font-size' as string]: `${previewFontSize}px` }}>
        {children}
      </div>

      {/* 8-direction resize hit zones (edges + corners) */}
      {renderZones()}

      {/* Visible bottom-right grip — purely a visual affordance; the actual
          hit zone is the `se` zone rendered above (which sits on top). */}
      <div
        data-ion-ui
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          pointerEvents: 'none',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.25 }}>
          <line x1="14" y1="6" x2="6" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
          <line x1="14" y1="10" x2="10" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
        </svg>
      </div>
    </motion.div>
  )

  const contextMenu = titleCtxMenu && filePath ? (
    <div
      data-ion-ui
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: titleCtxMenu.x,
        top: titleCtxMenu.y,
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        padding: '4px 0',
        zIndex: 99999,
        fontFamily: 'system-ui',
        fontSize: 12,
      }}
    >
      <button
        style={{
          display: 'block',
          width: '100%',
          padding: '5px 12px',
          background: 'transparent',
          border: 'none',
          color: colors.textSecondary,
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'system-ui',
          fontSize: 12,
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = colors.surfaceHover
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
        onClick={() => {
          void navigator.clipboard.writeText(filePath)
          setTitleCtxMenu(null)
        }}
      >
        Copy Path
      </button>
      <button
        style={{
          display: 'block',
          width: '100%',
          padding: '5px 12px',
          background: 'transparent',
          border: 'none',
          color: colors.textSecondary,
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'system-ui',
          fontSize: 12,
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = colors.surfaceHover
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
        onClick={() => {
          const relativePath =
            workingDir && filePath.startsWith(workingDir + '/')
              ? filePath.slice(workingDir!.length + 1)
              : filePath
          void navigator.clipboard.writeText(relativePath)
          setTitleCtxMenu(null)
        }}
      >
        Copy Relative Path
      </button>
    </div>
  ) : null

  return createPortal(
    <>
      {panel}
      {contextMenu}
    </>,
    popoverLayer,
  )
}
