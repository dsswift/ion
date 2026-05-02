import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, GearSix, GitBranch, Columns, PaintBrush, TerminalWindow, SlidersHorizontal, WifiHigh, Plugs } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { GeneralCategory } from './settings/GeneralCategory'
import { GitCategory } from './settings/GitCategory'
import { TabsPanelsCategory } from './settings/TabsPanelsCategory'
import { AppearanceCategory } from './settings/AppearanceCategory'
import { EditorTerminalCategory } from './settings/EditorTerminalCategory'
import { PresetsCategory } from './settings/PresetsCategory'
import { RemoteCategory } from './settings/RemoteCategory'
import { EngineCategory } from './settings/EngineCategory'
import type { Icon } from '@phosphor-icons/react'

interface Category {
  id: string
  label: string
  icon: Icon
  component: React.FC
}

const CATEGORIES: Category[] = [
  { id: 'presets', label: 'Presets', icon: SlidersHorizontal, component: PresetsCategory },
  { id: 'general', label: 'General', icon: GearSix, component: GeneralCategory },
  { id: 'git', label: 'Git', icon: GitBranch, component: GitCategory },
  { id: 'tabs', label: 'Tabs & Panels', icon: Columns, component: TabsPanelsCategory },
  { id: 'appearance', label: 'Appearance', icon: PaintBrush, component: AppearanceCategory },
  { id: 'editor', label: 'Editor & Terminal', icon: TerminalWindow, component: EditorTerminalCategory },
  { id: 'remote', label: 'Remote', icon: WifiHigh, component: RemoteCategory },
  { id: 'engine', label: 'Engine', icon: Plugs, component: EngineCategory },
]

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

interface SettingsDialogProps {
  onClose: () => void
}

const DIALOG_WIDTH = 700
const DIALOG_HEIGHT = 600

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [activeCategory, setActiveCategory] = useState('general')

  // Position: always start centered
  const [pos, setPos] = useState(() => ({
    x: (window.innerWidth - DIALOG_WIDTH) / 2,
    y: (window.innerHeight - DIALOG_HEIGHT) / 2,
  }))
  const dragRef = useRef<{
    startX: number; startY: number; originX: number; originY: number
  } | null>(null)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
  }, [pos])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      const newX = Math.max(-200, Math.min(window.innerWidth - 100, dragRef.current.originX + dx))
      const newY = Math.max(0, Math.min(window.innerHeight - 32, dragRef.current.originY + dy))
      setPos({ x: newX, y: newY })
    }
    const handleMouseUp = () => { dragRef.current = null }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Escape key dismisses
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (!popoverLayer) return null

  const active = CATEGORIES.find((c) => c.id === activeCategory) || CATEGORIES[0]
  const ActiveContent = active.component

  return createPortal(
    <motion.div
      data-ion-ui
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={TRANSITION}
      className="glass-surface"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: DIALOG_WIDTH,
        maxHeight: DIALOG_HEIGHT,
        borderRadius: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 9999,
      }}
    >
      {/* Header — drag handle */}
      <div
        onMouseDown={handleDragStart}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 10px',
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
          Settings
        </span>
        <button
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: colors.textTertiary,
            padding: 4,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Two-column layout: sidebar + content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <div
          style={{
            width: 160,
            borderRight: `1px solid ${colors.containerBorder}`,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            flexShrink: 0,
          }}
        >
          {CATEGORIES.map((cat) => {
            const isActive = cat.id === activeCategory
            const IconComp = cat.icon
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  color: isActive ? colors.textPrimary : colors.textSecondary,
                  background: isActive ? colors.surfaceSecondary : 'transparent',
                  transition: 'background 0.15s, color 0.15s',
                  width: '100%',
                  textAlign: 'left',
                }}
              >
                <IconComp size={16} weight={isActive ? 'fill' : 'regular'} />
                {cat.label}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
          <ActiveContent />
        </div>
      </div>
    </motion.div>,
    popoverLayer,
  )
}
