import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Plus, CaretDown, Rows, ArrowRight } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore, getEffectiveTabGroups } from '../preferences'
import type { TabGroupView } from '../hooks/useTabGroups'
import { zoomRect, zoomViewport } from './TabStripShared'

interface InactiveGroupMenuProps {
  anchor: { x: number; y: number }
  group: TabGroupView
  onClose: () => void
}

/** Right-click context menu for an inactive (non-selected) group pill. Lets the user move all tabs in the group to another group. */
export function InactiveGroupMenu({
  anchor,
  group,
  onClose,
}: InactiveGroupMenuProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  const tabGroups = usePreferencesStore((s) => s.tabGroups)
  const moveTabToGroup = useSessionStore((s) => s.moveTabToGroup)
  const [moveSubmenu, setMoveSubmenu] = useState<{ x: number; y: number } | null>(null)
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          (!submenuRef.current || !submenuRef.current.contains(e.target as Node))) { setMoveSubmenu(null); onClose() }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoveSubmenu(null); onClose() }
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

  const vp = zoomViewport()
  const top = Math.min(anchor.y + 8, vp.height - 200)
  const left = Math.min(anchor.x, vp.width - 180)

  const menuItemStyle = { fontSize: 12, color: colors.textPrimary, background: 'transparent' as string, border: 'none' as const, cursor: 'pointer' as const }

  const moveAllToGroup = (targetGroupId: string) => {
    for (const tab of group.tabs) {
      moveTabToGroup(tab.id, targetGroupId)
    }
    onClose()
  }

  // Build available targets
  const effectiveGroups = getEffectiveTabGroups(tabGroups)
  const targets = effectiveGroups
    .filter((g) => g.id !== group.groupId)
    .map((g) => ({ id: g.id, label: g.label }))

  return createPortal(
    <motion.div
      ref={ref}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left,
        top,
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10000,
        minWidth: 160,
      }}
    >
      <button
        ref={moveItemRef}
        className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
        style={menuItemStyle}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = colors.tabActive
          if (moveItemRef.current) {
            const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
            setMoveSubmenu({ x: rect.right, y: rect.top })
          }
        }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        onClick={() => {
          if (moveItemRef.current) {
            const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
            setMoveSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
          }
        }}
      >
        <Rows size={14} color={colors.textSecondary} />
        <span>Move all to group</span>
        <CaretDown size={10} color={colors.textTertiary} style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />
      </button>
      {moveSubmenu && createPortal(
        <motion.div
          ref={(node) => { (submenuRef as React.MutableRefObject<HTMLDivElement | null>).current = node }}
          data-ion-ui
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.1 }}
          style={{
            position: 'fixed',
            left: Math.min(moveSubmenu.x + 8, zoomViewport().width - 180),
            top: Math.min(moveSubmenu.y, zoomViewport().height - 200),
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
            Move all to group
          </div>
          {targets.map((t) => (
            <button
              key={t.id}
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
              style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              onClick={() => moveAllToGroup(t.id)}
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
                        moveAllToGroup(id)
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
      )}
    </motion.div>,
    popoverLayer,
  )
}
