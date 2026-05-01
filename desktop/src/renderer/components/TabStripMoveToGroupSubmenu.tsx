import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Plus, ArrowRight } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore, getEffectiveTabGroups } from '../preferences'
import { zoomViewport } from './TabStripShared'

interface MoveToGroupSubmenuProps {
  anchor: { x: number; y: number }
  tabId: string
  currentGroupId: string
  onClose: () => void
  containerRef?: React.RefObject<HTMLDivElement | null>
}

/** Submenu listing destination tab-groups for a single tab. Auto and manual modes show different target sets. */
export function MoveToGroupSubmenu({
  anchor,
  tabId,
  currentGroupId,
  onClose,
  containerRef,
}: MoveToGroupSubmenuProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  const tabGroups = usePreferencesStore((s) => s.tabGroups)

  const setRefs = useCallback((node: HTMLDivElement | null) => {
    (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    if (containerRef) (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }, [containerRef])
  const tabs = useSessionStore((s) => s.tabs)
  const moveTabToGroup = useSessionStore((s) => s.moveTabToGroup)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  useEffect(() => {
    if (showNewGroupInput) inputRef.current?.focus()
  }, [showNewGroupInput])

  if (!popoverLayer) return null

  // Build available targets
  let targets: Array<{ id: string; label: string }> = []

  if (tabGroupMode === 'auto') {
    // Available directories that have 2+ tabs
    const dirMap = new Map<string, string>()
    for (const t of tabs) {
      const key = t.workingDirectory || '~'
      if (!dirMap.has(key)) dirMap.set(key, key.split('/').pop() || key)
    }
    targets = Array.from(dirMap.entries())
      .filter(([dir]) => `auto-${dir}` !== currentGroupId)
      .map(([dir, label]) => ({ id: `auto-${dir}`, label }))
  } else if (tabGroupMode === 'manual') {
    const effectiveGroups = getEffectiveTabGroups(tabGroups)
    targets = effectiveGroups
      .filter((g) => g.id !== currentGroupId)
      .map((g) => ({ id: g.id, label: g.label }))
  }

  const vp = zoomViewport()
  const top = Math.min(anchor.y, vp.height - 200)
  const left = Math.min(anchor.x + 8, vp.width - 180)

  return createPortal(
    <motion.div
      ref={setRefs}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'fixed',
        left,
        top,
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10001,
        minWidth: 160,
      }}
    >
      <div className="px-2 py-1 text-[10px] font-medium" style={{ color: colors.textTertiary }}>
        Move to group
      </div>
      {targets.map((t) => (
        <button
          key={t.id}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          onClick={() => {
            moveTabToGroup(tabId, t.id)
            onClose()
          }}
        >
          <ArrowRight size={12} color={colors.textTertiary} />
          <span>{t.label}</span>
        </button>
      ))}
      {tabGroupMode === 'manual' && (
        <>
          <div style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }} />
          {showNewGroupInput ? (
            <div className="flex items-center gap-1 px-2 py-1">
              <input
                ref={inputRef}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newGroupName.trim()) {
                    const id = usePreferencesStore.getState().createTabGroup(newGroupName.trim())
                    moveTabToGroup(tabId, id)
                    onClose()
                  }
                  if (e.key === 'Escape') setShowNewGroupInput(false)
                }}
                placeholder="Group name..."
                style={{
                  flex: 1, fontSize: 12, background: 'transparent', border: `1px solid ${colors.inputBorder}`,
                  borderRadius: 4, padding: '2px 6px', color: colors.textPrimary, outline: 'none',
                }}
              />
            </div>
          ) : (
            <button
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
              style={{ fontSize: 12, color: colors.accent, background: 'transparent', border: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              onClick={() => setShowNewGroupInput(true)}
            >
              <Plus size={12} color={colors.accent} />
              <span>New group...</span>
            </button>
          )}
        </>
      )}
    </motion.div>,
    popoverLayer,
  )
}
