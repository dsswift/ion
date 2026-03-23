import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

interface FloatingPanelProps {
  title: string
  onClose: () => void
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  children: React.ReactNode
}

export function FloatingPanel({
  title,
  onClose,
  defaultWidth = 680,
  defaultHeight = 420,
  minWidth = 280,
  minHeight = 180,
  children,
}: FloatingPanelProps) {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  // Position: start offset toward the left so it doesn't cover the main conversation column
  const [pos, setPos] = useState({ x: 60, y: 80 })
  const [size, setSize] = useState({ w: defaultWidth, h: defaultHeight })

  // Drag state
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  // Resize state
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only drag from header (left button)
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
  }, [pos])

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
        // Clamp so the header bar (top 32px) always stays within the viewport
        const newX = Math.max(-200, Math.min(window.innerWidth - 100, dragRef.current.originX + dx))
        const newY = Math.max(0, Math.min(window.innerHeight - 32, dragRef.current.originY + dy))
        setPos({ x: newX, y: newY })
      }
      if (resizeRef.current) {
        const dx = e.clientX - resizeRef.current.startX
        const dy = e.clientY - resizeRef.current.startY
        setSize({
          w: Math.max(minWidth, resizeRef.current.originW + dx),
          h: Math.max(minHeight, resizeRef.current.originH + dy),
        })
      }
    }
    const handleMouseUp = () => {
      dragRef.current = null
      resizeRef.current = null
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [minWidth, minHeight])

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!popoverLayer) return null

  const panel = (
    <motion.div
      data-coda-ui
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
        data-coda-ui
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
        >
          {title}
        </span>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* Resize handle (bottom-right corner) */}
      <div
        data-coda-ui
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.25 }}>
          <line x1="14" y1="6" x2="6" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
          <line x1="14" y1="10" x2="10" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
        </svg>
      </div>
    </motion.div>
  )

  return createPortal(panel, popoverLayer)
}
