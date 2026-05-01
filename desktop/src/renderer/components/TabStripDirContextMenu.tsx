import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FolderPlus, GitFork, CheckCircle, CaretDown, Rows } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore } from '../preferences'
import { zoomRect } from './TabStripShared'
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
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          (!submenuRef.current || !submenuRef.current.contains(e.target as Node))) {
        setMoveSubmenu(null)
        onClose()
      }
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

  if (!popoverLayer) return null

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
        left: anchor.x,
        top: anchor.y + 8,
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
            <span>Move to group</span>
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
          onClose={() => { setMoveSubmenu(null); onClose() }}
        />
      )}
    </motion.div>,
    popoverLayer,
  )
}
