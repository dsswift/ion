import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Plus, ArrowRight } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore, getEffectiveTabGroups } from '../preferences'
import { useAnchoredPopoverPosition, zoomViewport } from './TabStripShared'

interface MoveToGroupSubmenuProps {
  anchor: { x: number; y: number }
  tabId: string
  currentGroupId: string
  onClose: () => void
  containerRef?: React.RefObject<HTMLDivElement | null>
  /**
   * When true, the submenu performs the combined "move and pin" action
   * (groupPinned=true alongside the group change) instead of a plain move.
   * Header text and the new-group creation path also pin the result.
   * Defaults to false to preserve the existing plain-move behavior.
   */
  pinAfter?: boolean
  /**
   * The bounding rect of the parent menu row that triggered this
   * submenu. Used by `useAnchoredPopoverPosition` to flip the submenu
   * to the left of the parent row when there isn't room to the right.
   * Optional — the hook falls back to flipping relative to `anchor.x`
   * when not provided, which is visually fine but slightly off.
   */
  parentRect?: { left: number; right: number; top: number; bottom: number }
}

/** Submenu listing destination tab-groups for a single tab. Auto and manual modes show different target sets. */
export function MoveToGroupSubmenu({
  anchor,
  tabId,
  currentGroupId,
  onClose,
  containerRef,
  pinAfter = false,
  parentRect,
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
  const moveTabToGroupAndPin = useSessionStore((s) => s.moveTabToGroupAndPin)
  // The destination handler is chosen once per submenu instance and used
  // for both the listed targets and the "new group" creation path so the
  // pin-vs-plain semantics stay consistent across every entry point.
  const performMove = pinAfter ? moveTabToGroupAndPin : moveTabToGroup
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

  // Build available targets. Computed before the early-popoverLayer
  // return so we can include `targets.length` in the positioning
  // hook's deps (the hook must run unconditionally — rules of hooks).
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
  // Position is computed by the shared hook so the submenu always
  // stays on-screen. `showNewGroupInput` is in `deps` because
  // expanding the inline input changes the submenu's rendered
  // height, and we want the menu to re-position so the input row
  // doesn't drop off the bottom edge.
  const pos = useAnchoredPopoverPosition(anchor, {
    prefer: 'rightOf',
    parentRect,
    deps: [showNewGroupInput, targets.length],
  })

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={(node) => { setRefs(node); pos.ref(node) }}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        maxHeight: vp.height - 16,
        overflowY: 'auto',
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
        {pinAfter ? 'Move to group and pin' : 'Move to group'}
      </div>
      {targets.map((t) => (
        <button
          key={t.id}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          onClick={() => {
            performMove(tabId, t.id)
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
                    performMove(tabId, id)
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
