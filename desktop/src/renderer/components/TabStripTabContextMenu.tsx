import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  Plus, GitFork, FolderOpen, GitBranch, CheckCircle, CaretDown, Rows,
  PencilSimple, ArrowRight, ArrowsInSimple,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore, getEffectiveTabGroups } from '../preferences'
import type { TabState } from '../../shared/types'
import { zoomRect, zoomViewport } from './TabStripShared'
import { MoveToGroupSubmenu } from './TabStripMoveToGroupSubmenu'

interface TabContextMenuProps {
  anchor: { x: number; y: number }
  tab: TabState
  onRename?: () => void
  onForkTab?: () => void
  onNewTabInDir: () => void
  onFinishWork: () => void
  finishWorkDisabled?: boolean | 'checking'
  onClose: () => void
  groupTabs?: TabState[]
}

/** Right-click context menu for a single tab pill (or for the active group pill when manual grouping is on). */
export function TabContextMenu({
  anchor,
  tab,
  onRename,
  onForkTab,
  onNewTabInDir,
  onFinishWork,
  finishWorkDisabled,
  onClose,
  groupTabs,
}: TabContextMenuProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  const tabGroups = usePreferencesStore((s) => s.tabGroups)
  const moveTabToGroup = useSessionStore((s) => s.moveTabToGroup)
  const [moveSubmenu, setMoveSubmenu] = useState<{ x: number; y: number } | null>(null)
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [moveAllSubmenu, setMoveAllSubmenu] = useState<{ x: number; y: number } | null>(null)
  const moveAllItemRef = useRef<HTMLButtonElement>(null)
  const moveAllSubmenuRef = useRef<HTMLDivElement>(null)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const newGroupInputRef = useRef<HTMLInputElement>(null)

  const showMoveAll = groupTabs && groupTabs.length > 1
  const [isGitRepo, setIsGitRepo] = useState(false)

  useEffect(() => {
    if (tab.workingDirectory && !tab.worktree) {
      window.ion.gitIsRepo(tab.workingDirectory).then(({ isRepo }) => setIsGitRepo(isRepo)).catch(() => setIsGitRepo(false))
    }
  }, [tab.workingDirectory, tab.worktree])

  useEffect(() => {
    if (showNewGroupInput) newGroupInputRef.current?.focus()
  }, [showNewGroupInput])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          (!submenuRef.current || !submenuRef.current.contains(e.target as Node)) &&
          (!moveAllSubmenuRef.current || !moveAllSubmenuRef.current.contains(e.target as Node))) { setMoveSubmenu(null); setMoveAllSubmenu(null); onClose() }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoveSubmenu(null); setMoveAllSubmenu(null); onClose() }
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  if (!popoverLayer) return null

  const menuItemStyle = {
    fontSize: 12,
    color: colors.textPrimary,
    background: 'transparent' as string,
    border: 'none' as const,
    cursor: 'pointer' as const,
  }

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
        minWidth: 160,
      }}
    >
      {onRename && (
        <button
          onClick={() => { onRename(); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={menuItemStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <PencilSimple size={14} color={colors.textSecondary} />
          <span>Rename</span>
        </button>
      )}
      {onForkTab && (
        <button
          onClick={() => { onForkTab(); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={menuItemStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <GitFork size={14} color={colors.textSecondary} />
          <span>Fork conversation</span>
        </button>
      )}
      {tab.workingDirectory && (
        <button
          onClick={() => { onNewTabInDir(); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={menuItemStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <FolderOpen size={14} color={colors.textSecondary} />
          <span>New tab in directory</span>
        </button>
      )}
      {!tab.worktree && isGitRepo && (
        <button
          onClick={tab.hasFileActivity ? undefined : () => { useSessionStore.getState().convertToWorktree(tab.id); window.dispatchEvent(new CustomEvent('ion:close-group-pickers')); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{
            ...menuItemStyle,
            ...(tab.hasFileActivity ? { color: colors.textTertiary, cursor: 'not-allowed', opacity: 0.5 } : {}),
          }}
          onMouseEnter={(e) => { if (!tab.hasFileActivity) (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <GitBranch size={14} color={tab.hasFileActivity ? colors.textTertiary : colors.textSecondary} />
          <span>Convert to worktree</span>
        </button>
      )}
      {tab.worktree && (
        <button
          onClick={() => { if (!finishWorkDisabled) { onFinishWork(); onClose() } }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{
            ...menuItemStyle,
            ...(finishWorkDisabled ? { color: colors.textTertiary, cursor: 'not-allowed', opacity: 0.5 } : {}),
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
            style={menuItemStyle}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = colors.tabActive
              setMoveAllSubmenu(null)
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
      {showMoveAll && tabGroupMode === 'manual' && (
        <button
          ref={moveAllItemRef}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={menuItemStyle}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = colors.tabActive
            setMoveSubmenu(null)
            if (moveAllItemRef.current) {
              const rect = zoomRect(moveAllItemRef.current.getBoundingClientRect())
              setMoveAllSubmenu({ x: rect.right, y: rect.top })
            }
          }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          onClick={() => {
            if (moveAllItemRef.current) {
              const rect = zoomRect(moveAllItemRef.current.getBoundingClientRect())
              setMoveAllSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
            }
          }}
        >
          <ArrowsInSimple size={14} color={colors.textSecondary} />
          <span>Move all to group</span>
          <CaretDown size={10} color={colors.textTertiary} style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />
        </button>
      )}
      {moveSubmenu && (
        <MoveToGroupSubmenu
          anchor={moveSubmenu}
          tabId={tab.id}
          currentGroupId={tab.groupId || ''}
          containerRef={submenuRef}
          onClose={() => { setMoveSubmenu(null); onClose() }}
        />
      )}
      {moveAllSubmenu && showMoveAll && popoverLayer && (() => {
        const currentGroupId = tab.groupId || ''
        const effectiveGroups = getEffectiveTabGroups(tabGroups)
        const targets = effectiveGroups
          .filter((g) => g.id !== currentGroupId)
          .map((g) => ({ id: g.id, label: g.label }))
        const moveAllToGroup = (targetGroupId: string) => {
          for (const t of groupTabs) moveTabToGroup(t.id, targetGroupId)
          onClose()
        }
        return createPortal(
          <motion.div
            ref={(node) => { (moveAllSubmenuRef as React.MutableRefObject<HTMLDivElement | null>).current = node }}
            data-ion-ui
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            style={{
              position: 'fixed',
              left: Math.min(moveAllSubmenu.x + 8, zoomViewport().width - 180),
              top: Math.min(moveAllSubmenu.y, zoomViewport().height - 200),
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
            <div style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }} />
            {showNewGroupInput ? (
              <div className="flex items-center gap-1 px-2 py-1">
                <input
                  ref={newGroupInputRef}
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
          </motion.div>,
          popoverLayer,
        )
      })()}
    </motion.div>,
    popoverLayer,
  )
}
