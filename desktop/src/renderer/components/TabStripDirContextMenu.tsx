import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FolderPlus, GitFork, CheckCircle, CaretDown, Rows, PushPin } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore } from '../preferences'
import { useAnchoredPopoverPosition, zoomRect, zoomViewport } from './TabStripShared'
import { MoveToGroupSubmenu } from './TabStripMoveToGroupSubmenu'

interface DirContextMenuProps {
  anchor: { x: number; y: number }
  dirName: string
  tabId?: string
  tabGroupId?: string
  onCreateTab: () => void
  onForkTab?: () => void
  onFinishWork?: () => void
  finishWorkDisabled?: boolean | 'checking'
  onClose: () => void
}

/** Right-click context menu for the directory label inside a tab pill. */
export function DirContextMenu({
  anchor,
  dirName,
  tabId,
  tabGroupId,
  onCreateTab,
  onForkTab,
  onFinishWork,
  finishWorkDisabled,
  onClose,
}: DirContextMenuProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  const [moveSubmenu, setMoveSubmenu] = useState<{ x: number; y: number } | null>(null)
  // Bounding rect of the "Move to group" row, captured at the moment
  // we open the submenu. Passed to `MoveToGroupSubmenu` so its
  // positioning hook can flip left when the right side overflows.
  const [moveParentRect, setMoveParentRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  // Parallel "Move to group and pin" submenu state — same pattern as
  // TabStripTabContextMenu so the dir-label right-click menu also offers
  // the combined move+pin shortcut.
  const [movePinSubmenu, setMovePinSubmenu] = useState<{ x: number; y: number } | null>(null)
  const [movePinParentRect, setMovePinParentRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const movePinItemRef = useRef<HTMLButtonElement>(null)
  const movePinSubmenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          (!submenuRef.current || !submenuRef.current.contains(e.target as Node)) &&
          (!movePinSubmenuRef.current || !movePinSubmenuRef.current.contains(e.target as Node))) {
        setMoveSubmenu(null)
        setMovePinSubmenu(null)
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoveSubmenu(null); setMovePinSubmenu(null); onClose() }
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Position the outer menu so it never overflows the viewport. The
  // hook measures the menu after mount and flips it upward if the
  // bottom would fall off-screen. `moveSubmenu` / `movePinSubmenu`
  // toggles are included in `deps` so the outer menu re-measures
  // when its child rows could change layout — currently they don't
  // affect outer height (submenus portal out), but keeping them in
  // deps protects against future structural changes that *would*
  // (e.g. an inline manual-mode panel).
  const pos = useAnchoredPopoverPosition(anchor, {
    prefer: 'below',
    deps: [tabGroupMode, !!onForkTab, !!onFinishWork, moveSubmenu, movePinSubmenu],
  })
  const vp = zoomViewport()

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={(node) => { (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.12 }}
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
        zIndex: 10000,
        minWidth: 140,
      }}
    >
      <button
        onClick={() => { onCreateTab(); onClose() }}
        className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
        style={{
          fontSize: 12,
          color: colors.textPrimary,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <FolderPlus size={14} color={colors.textSecondary} />
        <span>New tab in {dirName}</span>
      </button>
      {onForkTab && (
        <button
          onClick={() => { onForkTab(); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{
            fontSize: 12,
            color: colors.textPrimary,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <GitFork size={14} color={colors.textSecondary} />
          <span>Fork conversation</span>
        </button>
      )}
      {onFinishWork && (
        <button
          onClick={() => { if (!finishWorkDisabled) { onFinishWork(); onClose() } }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{
            fontSize: 12,
            color: finishWorkDisabled ? colors.textTertiary : colors.textPrimary,
            background: 'transparent',
            border: 'none',
            cursor: finishWorkDisabled ? 'not-allowed' : 'pointer',
            opacity: finishWorkDisabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => { if (!finishWorkDisabled) (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <CheckCircle size={14} color={finishWorkDisabled ? colors.textTertiary : '#4ade80'} />
          <span>{finishWorkDisabled === 'checking' ? 'Finish work (checking...)' : finishWorkDisabled ? 'Finish work (uncommitted changes)' : 'Finish work'}</span>
        </button>
      )}
      {tabGroupMode === 'manual' && (
        <>
          <div style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }} />
          <button
            ref={moveItemRef}
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = colors.tabActive
              setMovePinSubmenu(null)
              setMovePinParentRect(null)
              if (moveItemRef.current) {
                const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
                setMoveSubmenu({ x: rect.right, y: rect.top })
                setMoveParentRect({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              if (moveItemRef.current) {
                const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
                setMoveSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
                setMoveParentRect((prev) => prev ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
          >
            <Rows size={14} color={colors.textSecondary} />
            <span>Move to group</span>
            <CaretDown size={10} color={colors.textTertiary} style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />
          </button>
          {/*
            Sibling row — same pattern as the TabContextMenu's pin variant.
            Uses the shared MoveToGroupSubmenu with `pinAfter`, so the user
            gets a single click that both moves the tab into the chosen
            group and sets groupPinned=true, protecting it from any
            subsequent auto-group-movement.
          */}
          <button
            ref={movePinItemRef}
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = colors.tabActive
              setMoveSubmenu(null)
              setMoveParentRect(null)
              if (movePinItemRef.current) {
                const rect = zoomRect(movePinItemRef.current.getBoundingClientRect())
                setMovePinSubmenu({ x: rect.right, y: rect.top })
                setMovePinParentRect({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              if (movePinItemRef.current) {
                const rect = zoomRect(movePinItemRef.current.getBoundingClientRect())
                setMovePinSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
                setMovePinParentRect((prev) => prev ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
          >
            <PushPin size={14} color={colors.textSecondary} />
            <span>Move to group and pin</span>
            <CaretDown size={10} color={colors.textTertiary} style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />
          </button>
        </>
      )}
      {moveSubmenu && tabId && (
        <MoveToGroupSubmenu
          anchor={moveSubmenu}
          tabId={tabId}
          currentGroupId={tabGroupId || ''}
          containerRef={submenuRef}
          parentRect={moveParentRect ?? undefined}
          onClose={() => { setMoveSubmenu(null); setMoveParentRect(null); onClose() }}
        />
      )}
      {movePinSubmenu && tabId && (
        <MoveToGroupSubmenu
          anchor={movePinSubmenu}
          tabId={tabId}
          currentGroupId={tabGroupId || ''}
          containerRef={movePinSubmenuRef}
          parentRect={movePinParentRect ?? undefined}
          pinAfter
          onClose={() => { setMovePinSubmenu(null); setMovePinParentRect(null); onClose() }}
        />
      )}
    </motion.div>,
    popoverLayer,
  )
}
