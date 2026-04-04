import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, GearSix, GitBranch, Columns, PaintBrush, TerminalWindow, SlidersHorizontal, WifiHigh } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { GeneralCategory } from './settings/GeneralCategory'
import { GitCategory } from './settings/GitCategory'
import { TabsPanelsCategory } from './settings/TabsPanelsCategory'
import { AppearanceCategory } from './settings/AppearanceCategory'
import { EditorTerminalCategory } from './settings/EditorTerminalCategory'
import { PresetsCategory } from './settings/PresetsCategory'
import { RemoteCategory } from './settings/RemoteCategory'
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
]

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] }

interface SettingsDialogProps {
  onClose: () => void
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [activeCategory, setActiveCategory] = useState('general')

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
      data-coda-ui
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={TRANSITION}
      className="glass-surface"
      style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 700,
        maxHeight: 600,
        borderRadius: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: 9999,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 10px',
        }}
      >
        <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
          Settings
        </span>
        <button
          onClick={onClose}
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
