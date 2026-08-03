import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, GearSix, GitBranch, Columns, PaintBrush, WifiHigh, Lightning, Brain, Faders, MagnifyingGlass, Bell, Keyboard, Buildings, Plugs } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { GeneralCategory } from './settings/GeneralCategory'
import { AIModelsCategory } from './settings/AIModelsCategory'
import { GitCategory } from './settings/GitCategory'
import { TabsPanelsCategory } from './settings/TabsPanelsCategory'
import { AppearanceCategory } from './settings/AppearanceCategory'
import { QuickToolsCategory } from './settings/QuickToolsCategory'
import { NotificationsCategory } from './settings/NotificationsCategory'
import { RemoteCategory } from './settings/RemoteCategory'
import { AdvancedCategory } from './settings/AdvancedCategory'
import { KeyboardShortcutsCategory } from './settings/KeyboardShortcutsCategory'
import { EntraCategory } from './settings/EntraCategory'
import { McpCategory } from './settings/McpCategory'
import { searchSettings } from './settings/settings-search-index'
import type { Icon } from '@phosphor-icons/react'

interface Category {
  id: string
  label: string
  icon: Icon
  component: React.FC
}

const CATEGORIES: Category[] = [
  { id: 'general', label: 'General', icon: GearSix, component: GeneralCategory },
  { id: 'ai', label: 'AI & Models', icon: Brain, component: AIModelsCategory },
  { id: 'appearance', label: 'Appearance', icon: PaintBrush, component: AppearanceCategory },
  { id: 'tabs', label: 'Tabs & Panels', icon: Columns, component: TabsPanelsCategory },
  { id: 'git', label: 'Git', icon: GitBranch, component: GitCategory },
  { id: 'quicktools', label: 'Quick Tools', icon: Lightning, component: QuickToolsCategory },
  { id: 'shortcuts', label: 'Keyboard', icon: Keyboard, component: KeyboardShortcutsCategory },
  { id: 'notifications', label: 'Notifications', icon: Bell, component: NotificationsCategory },
  { id: 'remote', label: 'Remote', icon: WifiHigh, component: RemoteCategory },
  { id: 'mcp', label: 'MCP Servers', icon: Plugs, component: McpCategory },
  { id: 'advanced', label: 'Advanced', icon: Faders, component: AdvancedCategory },
  { id: 'entra', label: 'Enterprise Auth', icon: Buildings, component: EntraCategory },
]

const LEGACY_TAB_MAP: Record<string, string> = {
  presets: 'advanced',
  migration: 'advanced',
  developer: 'advanced',
  editor: 'appearance',
  engine: 'ai',
}

function resolveTab(tab: string | null | undefined): string {
  if (!tab) return 'general'
  const mapped = LEGACY_TAB_MAP[tab]
  if (mapped) return mapped
  if (CATEGORIES.some((c) => c.id === tab)) return tab
  return 'general'
}

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

/** One sidebar category row. Extracted so `useInteractiveState` runs per
 *  row (hooks cannot run inside the parent's map). Keeps the existing
 *  active convention (`surfaceSecondary` fill + filled icon); hover and
 *  pressed layer the standard surface cascade on top. */
function CategoryButton({ category, isActive, onPick }: {
  category: Category
  isActive: boolean
  onPick: () => void
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const IconComp = category.icon
  return (
    <button
      onClick={onPick}
      {...handlers}
      className="ion-focusable"
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
        background: pressed
          ? colors.surfacePressed
          : isActive ? colors.surfaceSecondary : hover ? colors.surfaceHover : 'transparent',
        transition: `background ${transitions.base}, color ${transitions.base}`,
        width: '100%',
        textAlign: 'left',
      }}
    >
      <IconComp size={16} weight={isActive ? 'fill' : 'regular'} />
      {category.label}
    </button>
  )
}

interface SettingsDialogProps {
  onClose: () => void
  initialTab?: string | null
}

const DIALOG_WIDTH = 700
const DIALOG_HEIGHT = 600

export function SettingsDialog({ onClose, initialTab }: SettingsDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const closeIx = useInteractiveState()
  const [activeCategory, setActiveCategory] = useState(resolveTab(initialTab))
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const matchedCategories = useMemo(() => searchSettings(searchQuery), [searchQuery])
  const isSearching = searchQuery.trim().length > 0

  const visibleCategories = isSearching
    ? CATEGORIES.filter((c) => matchedCategories.has(c.id))
    : CATEGORIES

  useEffect(() => {
    if (isSearching && visibleCategories.length > 0 && !matchedCategories.has(activeCategory)) {
      setActiveCategory(visibleCategories[0].id)
    }
  }, [isSearching, visibleCategories, matchedCategories, activeCategory])

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
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
        // viewport-ok: draggable dialog, centred on open from the live window size and bounded by the drag handler so a title bar always stays grabbable.
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
      {/* Header */}
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
          onMouseEnter={closeIx.handlers.onMouseEnter}
          onMouseLeave={closeIx.handlers.onMouseLeave}
          onMouseUp={closeIx.handlers.onMouseUp}
          onBlur={closeIx.handlers.onBlur}
          // stopPropagation keeps the drag-to-move header from grabbing the
          // press; pressed state is tracked in the same handler.
          onMouseDown={(e) => { e.stopPropagation(); closeIx.handlers.onMouseDown() }}
          className="ion-focusable"
          style={{
            background: interactiveBg(colors, closeIx),
            border: 'none',
            cursor: 'pointer',
            color: closeIx.hover ? colors.textSecondary : colors.textTertiary,
            padding: 4,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            transition: `background ${transitions.base}, color ${transitions.base}`,
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Two-column layout */}
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
          {/* Search */}
          <div
            style={{
              position: 'relative',
              marginBottom: 6,
            }}
          >
            <MagnifyingGlass
              size={13}
              style={{
                position: 'absolute',
                left: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                color: colors.textTertiary,
                pointerEvents: 'none',
              }}
            />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                padding: '5px 8px 5px 26px',
                fontSize: 12,
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 8,
                color: colors.textPrimary,
                outline: 'none',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = colors.accent }}
              onBlur={(e) => { e.currentTarget.style.borderColor = colors.containerBorder }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  right: 4,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: colors.textTertiary,
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>

          {isSearching && visibleCategories.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 11, color: colors.textTertiary }}>
              No results
            </div>
          )}

          {visibleCategories.map((cat) => (
            <CategoryButton
              key={cat.id}
              category={cat}
              isActive={cat.id === activeCategory}
              onPick={() => {
                setActiveCategory(cat.id)
                setSearchQuery('')
              }}
            />
          ))}
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
