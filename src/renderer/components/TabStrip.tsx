import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import { Plus, X, Prohibit, Terminal, FolderPlus, FolderOpen, GitBranch, GitFork, FolderSimple, CheckCircle, CaretDown, Rows, PencilSimple, Trash, Star, ArrowRight, ArrowsInSimple, ArrowsOutSimple } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { WorktreeCloseDialog } from './WorktreeCloseDialog'
import { BranchPickerDialog } from './BranchPickerDialog'
import { usePopoverLayer } from './PopoverLayer'
import { useColors, useThemeStore, getEffectiveTabGroups } from '../theme'
import { useTabGroups } from '../hooks/useTabGroups'
import type { TabGroupView } from '../hooks/useTabGroups'
import type { TabStatus, TabState, WorktreeStatus } from '../../shared/types'

/** Check whether this tab-creation event should use worktree mode, inverting the default when Alt is held */
const shouldUseWorktree = (altKey: boolean): boolean => {
  const gitOpsMode = useThemeStore.getState().gitOpsMode
  return altKey ? gitOpsMode !== 'worktree' : gitOpsMode === 'worktree'
}

const PILL_COLOR_PRESETS = [
  { color: null, label: 'Default' },
  { color: '#d97757', label: 'Orange' },
  { color: '#7aac8c', label: 'Green' },
  { color: '#c47060', label: 'Red' },
  { color: '#7a9ecc', label: 'Blue' },
  { color: '#b898c8', label: 'Purple' },
  { color: '#c4a84d', label: 'Gold' },
] as const

function StatusDot({ status, hasUnread, hasPermission, bashExecuting, waitingState }: { status: TabStatus; hasUnread: boolean; hasPermission: boolean; bashExecuting: boolean; waitingState: 'plan-ready' | 'question' | null }) {
  const colors = useColors()
  let bg: string = colors.statusIdle
  let pulse = false
  let glow = false
  let glowColor = colors.statusPermissionGlow

  if (status === 'dead' || status === 'failed') {
    bg = colors.statusError
  } else if (hasPermission) {
    bg = colors.statusPermission
    glow = true
  } else if (waitingState === 'plan-ready') {
    bg = colors.statusComplete
    glow = true
    glowColor = colors.tabGlowPlanReady
  } else if (waitingState === 'question') {
    bg = colors.infoText
    glow = true
    glowColor = colors.tabGlowQuestion
  } else if (status === 'connecting' || status === 'running') {
    bg = colors.statusRunning
    pulse = true
  } else if (bashExecuting) {
    bg = colors.statusBash
    pulse = true
    glow = true
    glowColor = colors.statusBashGlow
  } else if (hasUnread) {
    bg = colors.statusComplete
  }

  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
      }}
    />
  )
}

function PillColorPicker({
  anchor,
  currentColor,
  onSelect,
  onClose,
}: {
  anchor: { x: number; y: number }
  currentColor: string | null
  onSelect: (color: string | null) => void
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)

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

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={ref}
      data-coda-ui
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
        padding: 6,
        display: 'flex',
        gap: 4,
        zIndex: 10000,
      }}
    >
      {PILL_COLOR_PRESETS.map((preset) => {
        const isSelected = preset.color === currentColor
        return (
          <button
            key={preset.color || 'default'}
            title={preset.label}
            onClick={() => { onSelect(preset.color); onClose() }}
            style={{
              width: 18,
              height: 18,
              borderRadius: 9999,
              border: isSelected ? `2px solid ${colors.textPrimary}` : `1px solid ${colors.textTertiary}`,
              background: preset.color || 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              opacity: isSelected ? 1 : 0.7,
            }}
          >
            {preset.color === null && <Prohibit size={12} color={colors.textTertiary} />}
          </button>
        )
      })}
    </motion.div>,
    popoverLayer,
  )
}

function DirContextMenu({
  anchor,
  dirName,
  tabId,
  tabGroupId,
  onCreateTab,
  onForkTab,
  onFinishWork,
  onClose,
}: {
  anchor: { x: number; y: number }
  dirName: string
  tabId?: string
  tabGroupId?: string
  onCreateTab: () => void
  onForkTab?: () => void
  onFinishWork?: () => void
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
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
      data-coda-ui
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
          onClick={() => { onFinishWork(); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <CheckCircle size={14} color={colors.textSecondary} />
          <span>Finish work</span>
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
                const rect = moveItemRef.current.getBoundingClientRect()
                setMoveSubmenu({ x: rect.right, y: rect.top })
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              if (moveItemRef.current) {
                const rect = moveItemRef.current.getBoundingClientRect()
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

function TabContextMenu({
  anchor,
  tab,
  onForkTab,
  onNewTabInDir,
  onFinishWork,
  onClose,
}: {
  anchor: { x: number; y: number }
  tab: TabState
  onForkTab?: () => void
  onNewTabInDir: () => void
  onFinishWork: () => void
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const [moveSubmenu, setMoveSubmenu] = useState<{ x: number; y: number } | null>(null)
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)

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
      data-coda-ui
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
      {tab.worktree && (
        <button
          onClick={() => { onFinishWork(); onClose() }}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={menuItemStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <CheckCircle size={14} color={colors.textSecondary} />
          <span>Finish work</span>
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
              if (moveItemRef.current) {
                const rect = moveItemRef.current.getBoundingClientRect()
                setMoveSubmenu({ x: rect.right, y: rect.top })
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              if (moveItemRef.current) {
                const rect = moveItemRef.current.getBoundingClientRect()
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
      {moveSubmenu && (
        <MoveToGroupSubmenu
          anchor={moveSubmenu}
          tabId={tab.id}
          currentGroupId={tab.groupId || ''}
          containerRef={submenuRef}
          onClose={() => { setMoveSubmenu(null); onClose() }}
        />
      )}
    </motion.div>,
    popoverLayer,
  )
}

function RecentDirsContextMenu({
  anchor,
  onSelectDir,
  onClose,
}: {
  anchor: { x: number; y: number }
  onSelectDir: (dir: string, altKey: boolean) => void
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const recentDirs = useThemeStore((s) => s.recentBaseDirectories)

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

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={ref}
      data-coda-ui
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
        minWidth: 180,
      }}
    >
      {recentDirs.length === 0 ? (
        <div
          className="flex items-center gap-2 w-full px-2 py-1.5"
          style={{ fontSize: 12, color: colors.textTertiary }}
        >
          No recent directories
        </div>
      ) : (
        recentDirs.map((dir) => {
          const homePath = useSessionStore.getState().staticInfo?.homePath || ''
          const displayPath = homePath && dir.startsWith(homePath) ? '~' + dir.slice(homePath.length) : dir
          return (
            <div
              key={dir}
              className="flex items-center w-full rounded px-2 py-1.5"
              style={{
                fontSize: 12,
                color: colors.textPrimary,
                background: 'transparent',
                cursor: 'pointer',
              }}
              title={dir}
              onClick={(e) => { onSelectDir(dir, e.altKey); onClose() }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <FolderOpen size={14} color={colors.textSecondary} style={{ flexShrink: 0, marginRight: 8 }} />
              <span style={{ whiteSpace: 'nowrap', flex: 1 }}>{displayPath}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  useThemeStore.getState().removeRecentBaseDirectory(dir)
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 2,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  marginLeft: 8,
                  opacity: 0.5,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
                title="Remove from recents"
              >
                <Trash size={12} color={colors.textTertiary} />
              </button>
            </div>
          )
        })
      )}
    </motion.div>,
    popoverLayer,
  )
}

function InlineRenameInput({
  value,
  onCommit,
  onCancel,
  color,
  fontWeight,
}: {
  value: string
  onCommit: (newValue: string) => void
  onCancel: () => void
  color: string
  fontWeight: number
}) {
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [inputWidth, setInputWidth] = useState(0)
  const committedRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (measureRef.current) {
      setInputWidth(measureRef.current.offsetWidth + 4)
    }
  }, [editValue])

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = editValue.trim()
    onCommit(trimmed)
  }, [editValue, onCommit])

  return (
    <>
      {/* Hidden measuring span */}
      <span
        ref={measureRef}
        style={{
          position: 'absolute',
          visibility: 'hidden',
          whiteSpace: 'pre',
          fontSize: 12,
          fontWeight,
        }}
      >
        {editValue || ' '}
      </span>
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
          e.stopPropagation()
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: Math.max(inputWidth, 20),
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: 0,
          margin: 0,
          fontSize: 12,
          fontWeight,
          color,
          fontFamily: 'inherit',
        }}
      />
    </>
  )
}

/* ─── Stacked status dots for group pills ─── */

function getTabStatusColor(tab: TabState, colors: ReturnType<typeof useColors>): { bg: string; pulse: boolean; glow: boolean; glowColor: string } {
  let bg = colors.statusIdle
  let pulse = false
  let glow = false
  let glowColor = colors.statusPermissionGlow

  const waitingState = (() => {
    const tools = tab.permissionDenied?.tools
    if (!tools?.length) return null
    if (tools.some((t) => t.toolName === 'AskUserQuestion')) return 'question'
    if (tools.some((t) => t.toolName === 'ExitPlanMode')) return 'plan-ready'
    return null
  })()

  if (tab.status === 'dead' || tab.status === 'failed') {
    bg = colors.statusError
  } else if (tab.permissionQueue.length > 0) {
    bg = colors.statusPermission; glow = true
  } else if (waitingState === 'plan-ready') {
    bg = colors.statusComplete; glow = true; glowColor = colors.tabGlowPlanReady
  } else if (waitingState === 'question') {
    bg = colors.infoText; glow = true; glowColor = colors.tabGlowQuestion
  } else if (tab.status === 'connecting' || tab.status === 'running') {
    bg = colors.statusRunning; pulse = true
  } else if (tab.bashExecuting) {
    bg = colors.statusBash; pulse = true; glow = true; glowColor = colors.statusBashGlow
  } else if (tab.hasUnread) {
    bg = colors.statusComplete
  }

  return { bg, pulse, glow, glowColor }
}

function StackedStatusDots({ tabs }: { tabs: TabState[] }) {
  const colors = useColors()
  const maxVisible = 5
  const visible = tabs.slice(0, maxVisible)
  const overflow = tabs.length - maxVisible

  return (
    <div className="flex items-center flex-shrink-0" style={{ marginRight: 2 }}>
      {visible.map((tab, i) => {
        const { bg, pulse, glow, glowColor } = getTabStatusColor(tab, colors)
        return (
          <span
            key={tab.id}
            className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
            style={{
              background: bg,
              marginLeft: i === 0 ? 0 : -3,
              zIndex: maxVisible - i,
              position: 'relative',
              ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
            }}
          />
        )
      })}
      {overflow > 0 && (
        <span
          className="text-[8px] flex-shrink-0"
          style={{ color: colors.textTertiary, marginLeft: 2 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

/* ─── Group picker dropdown ─── */

function GroupPickerDropdown({
  group,
  anchor,
  onSelectTab,
  onCloseTab,
  onClose,
}: {
  group: TabGroupView
  anchor: { x: number; y: number }
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const renameTab = useSessionStore((s) => s.renameTab)
  const setTabPillColor = useSessionStore((s) => s.setTabPillColor)

  // Sub-interaction state
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)
  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirMenuTabId, setDirMenuTabId] = useState<string | null>(null)
  const [dirMenuAnchor, setDirMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [localTabs, setLocalTabs] = useState(group.tabs)

  useEffect(() => {
    setLocalTabs(group.tabs)
  }, [group.tabs])

  // Track whether a sub-popover is open so outside-click doesn't dismiss the dropdown
  const hasSubPopover = colorPickerTabId != null || dirMenuTabId != null

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // If a sub-popover is open, check if click landed inside a portaled popover child
        if (hasSubPopover) {
          const target = e.target as HTMLElement
          if (target.closest?.('[data-coda-ui]')) return // click inside a child popover — let it handle
          setColorPickerTabId(null)
          setDirMenuTabId(null)
          return
        }
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close sub-popovers first, then dropdown
        if (hasSubPopover) {
          setColorPickerTabId(null)
          setDirMenuTabId(null)
          return
        }
        if (editingTabId) {
          setEditingTabId(null)
          return
        }
        setConfirmingCloseId(null)
        onClose()
      }
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose, hasSubPopover, editingTabId])

  if (!popoverLayer) return null

  const top = Math.min(anchor.y + 8, window.innerHeight - 300)
  const left = Math.min(anchor.x, window.innerWidth - 280)

  return createPortal(
    <motion.div
      ref={ref}
      data-coda-ui
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left,
        top,
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 10,
        padding: 4,
        zIndex: 10000,
        minWidth: 220,
        maxWidth: 340,
        maxHeight: 300,
        overflowY: 'auto',
      }}
    >
      <Reorder.Group
        as="div"
        axis="y"
        values={localTabs}
        onReorder={(reordered) => {
          setLocalTabs(reordered)
          const reorderMap = new Map(reordered.map((t, i) => [t.id, i]))
          const allTabs = useSessionStore.getState().tabs
          const result = [...allTabs]
          const groupIndices = allTabs
            .map((t, i) => reorderMap.has(t.id) ? i : -1)
            .filter((i) => i >= 0)
          reordered.forEach((t, i) => { result[groupIndices[i]] = t })
          useSessionStore.getState().reorderTabs(result)
        }}
        style={{ listStyle: 'none', padding: 0, margin: 0 }}
      >
        {localTabs.map((tab) => (
          <DropdownTabRow
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            colors={colors}
            activeTabId={activeTabId}
            confirmingCloseId={confirmingCloseId}
            editingTabId={editingTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onClose={onClose}
            setConfirmingCloseId={setConfirmingCloseId}
            setColorPickerTabId={setColorPickerTabId}
            setColorPickerAnchor={setColorPickerAnchor}
            setDirMenuTabId={setDirMenuTabId}
            setDirMenuAnchor={setDirMenuAnchor}
            setEditingTabId={setEditingTabId}
            renameTab={renameTab}
          />
        ))}
      </Reorder.Group>

      {/* Sub-popovers: color picker */}
      <AnimatePresence>
        {colorPickerTabId && (() => {
          const pickerTab = group.tabs.find((t) => t.id === colorPickerTabId)
          if (!pickerTab) return null
          return (
            <PillColorPicker
              key="dropdown-color-picker"
              anchor={colorPickerAnchor}
              currentColor={pickerTab.pillColor}
              onSelect={(color) => { setTabPillColor(colorPickerTabId, color); setColorPickerTabId(null) }}
              onClose={() => setColorPickerTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

      {/* Sub-popovers: dir context menu */}
      <AnimatePresence>
        {dirMenuTabId && (() => {
          const menuTab = group.tabs.find((t) => t.id === dirMenuTabId)
          if (!menuTab?.workingDirectory) return null
          const menuDirName = menuTab.workingDirectory.split('/').pop() || menuTab.workingDirectory
          return (
            <DirContextMenu
              key="dropdown-dir-menu"
              anchor={dirMenuAnchor}
              dirName={menuDirName}
              tabId={menuTab.id}
              tabGroupId={menuTab.groupId || undefined}
              onCreateTab={() => {
                useSessionStore.getState().createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))
                setDirMenuTabId(null)
              }}
              onForkTab={menuTab.claudeSessionId ? () => {
                useSessionStore.getState().forkTab(menuTab.id)
                setDirMenuTabId(null)
              } : undefined}
              onFinishWork={menuTab.worktree ? () => {
                useSessionStore.getState().finishWorktreeTab(menuTab.id)
                setDirMenuTabId(null)
              } : undefined}
              onClose={() => setDirMenuTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

    </motion.div>,
    popoverLayer,
  )
}

/* ─── Dropdown tab row (extracted for useDragControls) ─── */

const DROPDOWN_DRAG_THRESHOLD = 8

function DropdownTabRow({
  tab,
  isActive,
  colors,
  activeTabId,
  confirmingCloseId,
  editingTabId,
  onSelectTab,
  onCloseTab,
  onClose,
  setConfirmingCloseId,
  setColorPickerTabId,
  setColorPickerAnchor,
  setDirMenuTabId,
  setDirMenuAnchor,
  setEditingTabId,
  renameTab,
}: {
  tab: TabState
  isActive: boolean
  colors: ReturnType<typeof useColors>
  activeTabId: string
  confirmingCloseId: string | null
  editingTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onClose: () => void
  setConfirmingCloseId: (id: string | null) => void
  setColorPickerTabId: (id: string | null) => void
  setColorPickerAnchor: (pos: { x: number; y: number }) => void
  setDirMenuTabId: (id: string | null) => void
  setDirMenuAnchor: (pos: { x: number; y: number }) => void
  setEditingTabId: (id: string | null) => void
  renameTab: (tabId: string, name: string | null) => void
}) {
  const dragControls = useDragControls()
  const isDragging = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    isDragging.current = false

    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!isDragging.current && Math.sqrt(dx * dx + dy * dy) >= DROPDOWN_DRAG_THRESHOLD) {
        isDragging.current = true
        dragControls.start(e.nativeEvent)
      }
    }
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      // Defer reset so the subsequent click event still sees isDragging=true
      requestAnimationFrame(() => { isDragging.current = false })
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }, [dragControls])

  const { bg, pulse, glow, glowColor } = getTabStatusColor(tab, colors)
  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const isConfirming = confirmingCloseId === tab.id
  const isEditing = editingTabId === tab.id
  const displayTitle = tab.customTitle || tab.title
  const dirName = tab.workingDirectory?.split('/').pop() || ''

  const waitingState: 'plan-ready' | 'question' | null = (() => {
    const tools = tab.permissionDenied?.tools
    if (!tools?.length) return null
    if (tools.some((t) => t.toolName === 'AskUserQuestion')) return 'question'
    if (tools.some((t) => t.toolName === 'ExitPlanMode')) return 'plan-ready'
    return null
  })()

  const waitingBorder = waitingState === 'plan-ready'
    ? colors.tabGlowPlanReady
    : waitingState === 'question'
      ? colors.tabGlowQuestion
      : null

  const defaultBorder = tab.pillColor ? `${tab.pillColor}40` : 'transparent'

  return (
    <Reorder.Item
      key={tab.id}
      value={tab}
      as="div"
      dragListener={false}
      dragControls={dragControls}
      initial={false}
      layout
      className={`flex items-center gap-1.5 w-full rounded px-2 py-1.5 cursor-pointer ${waitingBorder ? 'animate-border-pulse' : ''}`}
      style={{
        '--border-waiting': waitingBorder ?? 'transparent',
        '--border-default': defaultBorder,
        background: tab.pillColor
          ? `${tab.pillColor}${isActive ? '18' : '10'}`
          : isActive ? colors.tabActive : 'transparent',
        borderLeft: `2px solid ${waitingBorder ?? defaultBorder}`,
        fontSize: 12,
        listStyle: 'none',
      } as React.CSSProperties}
      onClick={() => {
        if (isDragging.current) return
        if (!isConfirming && !isEditing) {
          setConfirmingCloseId(null)
          onSelectTab(tab.id)
          onClose()
        }
      }}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          if (!isRunning && !tab.bashExecuting) onCloseTab(tab.id)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDirMenuTabId(tab.id)
        setDirMenuAnchor({ x: e.clientX, y: e.clientY })
      }}
      onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = tab.pillColor ? `${tab.pillColor}18` : colors.surfaceHover }}
      onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = tab.pillColor ? `${tab.pillColor}10` : 'transparent' }}
    >
      <span
        className="flex-shrink-0 inline-flex items-center justify-center"
        style={{ width: 14, height: 14, cursor: 'default' }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setColorPickerTabId(tab.id)
          setColorPickerAnchor({ x: e.clientX, y: e.clientY })
        }}
      >
        <span
          className={`w-[6px] h-[6px] rounded-full ${pulse ? 'animate-pulse-dot' : ''}`}
          style={{
            background: bg,
            ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
          }}
        />
      </span>

      {tab.workingDirectory && (
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: colors.textSecondary,
            opacity: 0.5,
            cursor: 'default',
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDirMenuTabId(tab.id)
            setDirMenuAnchor({ x: e.clientX, y: e.clientY })
          }}
        >
          {dirName}
        </span>
      )}

      {isEditing ? (
        <InlineRenameInput
          value={displayTitle}
          color={isActive ? colors.textPrimary : colors.textSecondary}
          fontWeight={isActive ? 500 : 400}
          onCommit={(newValue) => {
            setEditingTabId(null)
            renameTab(tab.id, newValue || null)
          }}
          onCancel={() => setEditingTabId(null)}
        />
      ) : (
        <span
          className="truncate flex-1"
          style={{ color: isActive ? colors.textPrimary : colors.textSecondary }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setEditingTabId(tab.id)
          }}
        >
          {displayTitle}
        </span>
      )}

      {isConfirming ? (
        <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setConfirmingCloseId(null)}
            className="px-1 rounded"
            style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            No
          </button>
          <button
            onClick={() => { onCloseTab(tab.id); setConfirmingCloseId(null) }}
            className="px-1 rounded"
            style={{ color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Yes
          </button>
        </div>
      ) : !isRunning && (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmingCloseId(tab.id) }}
          className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center"
          style={{ opacity: 0.5, color: colors.textSecondary, background: 'none', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
        >
          <X size={10} />
        </button>
      )}
    </Reorder.Item>
  )
}

/* ─── Move to group submenu ─── */

function MoveToGroupSubmenu({
  anchor,
  tabId,
  currentGroupId,
  onClose,
  containerRef,
}: {
  anchor: { x: number; y: number }
  tabId: string
  currentGroupId: string
  onClose: () => void
  containerRef?: React.RefObject<HTMLDivElement | null>
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const tabGroups = useThemeStore((s) => s.tabGroups)

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

  const top = Math.min(anchor.y, window.innerHeight - 200)
  const left = Math.min(anchor.x + 8, window.innerWidth - 180)

  return createPortal(
    <motion.div
      ref={setRefs}
      data-coda-ui
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
            if (tabGroupMode === 'auto') {
              // For auto mode, set the workingDirectory
              const dir = t.id.replace('auto-', '')
              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((tab) => tab.id === tabId ? { ...tab, groupId: t.id } : tab),
              }))
            } else {
              moveTabToGroup(tabId, t.id)
            }
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
                    const id = useThemeStore.getState().createTabGroup(newGroupName.trim())
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

/* ─── Group management context menu (manual mode) ─── */

function GroupManagementMenu({
  anchor,
  groupId,
  groupLabel,
  isDefault,
  onClose,
}: {
  anchor: { x: number; y: number }
  groupId: string
  groupLabel: string
  isDefault: boolean
  onClose: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(groupLabel)
  const renameRef = useRef<HTMLInputElement>(null)

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
    if (renaming) renameRef.current?.focus()
  }, [renaming])

  if (!popoverLayer) return null

  const top = Math.min(anchor.y + 8, window.innerHeight - 200)
  const left = Math.min(anchor.x, window.innerWidth - 180)

  const menuItemStyle = { fontSize: 12, color: colors.textPrimary, background: 'transparent' as string, border: 'none' as const, cursor: 'pointer' as const }

  return createPortal(
    <motion.div
      ref={ref}
      data-coda-ui
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
        zIndex: 10001,
        minWidth: 160,
      }}
    >
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameValue.trim()) {
                useThemeStore.getState().renameTabGroup(groupId, renameValue.trim())
                onClose()
              }
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={() => {
              if (renameValue.trim()) {
                useThemeStore.getState().renameTabGroup(groupId, renameValue.trim())
              }
              onClose()
            }}
            style={{
              flex: 1, fontSize: 12, background: 'transparent', border: `1px solid ${colors.inputBorder}`,
              borderRadius: 4, padding: '2px 6px', color: colors.textPrimary, outline: 'none',
            }}
          />
        </div>
      ) : (
        <>
          <button
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={menuItemStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => setRenaming(true)}
          >
            <PencilSimple size={14} color={colors.textSecondary} />
            <span>Rename group</span>
          </button>
          {!isDefault && (
            <button
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
              style={menuItemStyle}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              onClick={() => { useThemeStore.getState().setDefaultTabGroup(groupId); onClose() }}
            >
              <Star size={14} color={colors.textSecondary} />
              <span>Set as default</span>
            </button>
          )}
          <div style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }} />
          <button
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={{ ...menuItemStyle, color: colors.statusError }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              // Move tabs from deleted group to default, then delete
              const defaultGroup = useThemeStore.getState().tabGroups.find((g) => g.isDefault && g.id !== groupId)
              if (defaultGroup) {
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) => t.groupId === groupId ? { ...t, groupId: defaultGroup.id } : t),
                }))
              }
              useThemeStore.getState().deleteTabGroup(groupId)
              onClose()
            }}
          >
            <Trash size={14} color={colors.statusError} />
            <span>Delete group</span>
          </button>
        </>
      )}
    </motion.div>,
    popoverLayer,
  )
}

/* ─── Group pill ─── */

function GroupPill({
  group,
  isActive,
  onSelect,
}: {
  group: TabGroupView
  isActive: boolean
  onSelect: (tabId: string) => void
}) {
  const colors = useColors()
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const renameTab = useSessionStore((s) => s.renameTab)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [mgmtMenu, setMgmtMenu] = useState<{ x: number; y: number } | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number } | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const pillRef = useRef<HTMLDivElement>(null)

  const selectedTab = group.tabs.find((t) => t.id === group.selectedTabId) || group.tabs[0]
  const displayTitle = selectedTab ? (selectedTab.customTitle || selectedTab.title) : ''

  // Derive aggregate waiting state: if ANY tab in the group is waiting on the user
  // Question takes priority over plan-ready across all tabs in the group
  const groupWaitingState: 'plan-ready' | 'question' | null = (() => {
    let hasPlanReady = false
    for (const t of group.tabs) {
      const tools = t.permissionDenied?.tools
      if (!tools?.length) continue
      if (tools.some((x) => x.toolName === 'AskUserQuestion')) return 'question'
      if (tools.some((x) => x.toolName === 'ExitPlanMode')) hasPlanReady = true
    }
    return hasPlanReady ? 'plan-ready' : null
  })()

  const waitingBorder = groupWaitingState === 'plan-ready'
    ? colors.tabGlowPlanReady
    : groupWaitingState === 'question'
      ? colors.tabGlowQuestion
      : null

  const handleClick = useCallback(() => {
    // Single-tab group: activate the tab directly
    if (group.tabs.length === 1) {
      onSelect(group.tabs[0].id)
      return
    }
    if (pillRef.current) {
      const rect = pillRef.current.getBoundingClientRect()
      setPickerAnchor({ x: rect.left, y: rect.bottom })
    }
    setPickerOpen((o) => !o)
  }, [group.tabs, onSelect])

  return (
    <>
      <div
        ref={pillRef}
        className={`group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 ${waitingBorder ? 'animate-border-pulse' : ''}`}
        style={{
          '--border-waiting': waitingBorder ?? 'transparent',
          '--border-default': isActive ? colors.tabActiveBorder : 'transparent',
          background: isActive ? colors.tabActive : 'transparent',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: waitingBorder ?? (isActive ? colors.tabActiveBorder : 'transparent'),
          borderRadius: 9999,
          padding: '4px 10px',
          fontSize: 12,
          color: isActive ? colors.textPrimary : colors.textTertiary,
          fontWeight: isActive ? 500 : 400,
        } as React.CSSProperties}
        onClick={handleClick}
        onContextMenu={(e) => {
          if (tabGroupMode === 'manual') {
            e.preventDefault()
            e.stopPropagation()
            if (group.tabs.length === 1) {
              setTabMenu({ x: e.clientX, y: e.clientY })
            } else {
              setMgmtMenu({ x: e.clientX, y: e.clientY })
            }
          }
        }}
      >
        <StackedStatusDots tabs={group.tabs} />
        <span className="flex-shrink-0 text-[10px] font-medium" style={{ color: colors.textSecondary, opacity: 0.5 }}>
          {group.label}
        </span>
        {isActive && selectedTab && (
          renamingTitle ? (
            <InlineRenameInput
              value={displayTitle}
              color={colors.textPrimary}
              fontWeight={500}
              onCommit={(newValue) => {
                setRenamingTitle(false)
                renameTab(selectedTab.id, newValue || null)
              }}
              onCancel={() => setRenamingTitle(false)}
            />
          ) : (
            <span
              className="truncate max-w-[100px]"
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setRenamingTitle(true)
              }}
            >
              {displayTitle}
            </span>
          )
        )}
        <span className="text-[10px] flex-shrink-0" style={{ color: colors.textTertiary }}>
          {group.tabs.length}
        </span>
        {group.tabs.length > 1 && (
          <CaretDown
            size={10}
            className="flex-shrink-0 transition-transform"
            style={{
              color: colors.textTertiary,
              transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        )}
        {group.tabs.length === 1 && (() => {
          const tab = group.tabs[0]
          const isRunning = tab.status === 'running' || tab.status === 'connecting'
          if (isRunning || tab.bashExecuting) return null
          if (confirmingClose) {
            return (
              <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setConfirmingClose(false)}
                  className="px-1 rounded"
                  style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  No
                </button>
                <button
                  onClick={() => { useSessionStore.getState().closeTab(tab.id); setConfirmingClose(false) }}
                  className="px-1 rounded"
                  style={{ color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Yes
                </button>
              </div>
            )
          }
          return (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmingClose(true) }}
              className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center"
              style={{ opacity: 0.5, color: colors.textSecondary, background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
            >
              <X size={10} />
            </button>
          )
        })()}
      </div>

      <AnimatePresence>
        {pickerOpen && (
          <GroupPickerDropdown
            key="group-picker"
            group={group}
            anchor={pickerAnchor}
            onSelectTab={(tabId) => { onSelect(tabId) }}
            onCloseTab={(tabId) => useSessionStore.getState().closeTab(tabId)}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {mgmtMenu && (
          <GroupManagementMenu
            key="group-mgmt"
            anchor={mgmtMenu}
            groupId={group.groupId}
            groupLabel={group.label}
            isDefault={group.isDefault}
            onClose={() => setMgmtMenu(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tabMenu && group.tabs.length === 1 && (() => {
          const tab = group.tabs[0]
          return (
            <TabContextMenu
              key="group-tab-ctx"
              anchor={tabMenu}
              tab={tab}
              onForkTab={tab.claudeSessionId ? () => { useSessionStore.getState().forkTab(tab.id) } : undefined}
              onNewTabInDir={() => useSessionStore.getState().createTabInDirectory(tab.workingDirectory, shouldUseWorktree(false))}
              onFinishWork={() => { if (tab.worktree) useSessionStore.getState().finishWorktreeTab(tab.id) }}
              onClose={() => setTabMenu(null)}
            />
          )
        })()}
      </AnimatePresence>
    </>
  )
}

const DRAG_THRESHOLD = 8

function TabPill({
  tab,
  isActive,
  isEditing,
  isConfirmingClose,
  onSelect,
  onClose,
  onStartEdit,
  onStopEdit,
  onRename,
  onConfirmClose,
  onCancelClose,
  onSetPillColor,
  colorPickerTabId,
  onOpenColorPicker,
  onCloseColorPicker,
  onOpenDirMenu,
  onCreateTabInDir,
  dirMenuTabId,
  onOpenTabMenu,
  tabRefs,
}: {
  tab: TabState
  isActive: boolean
  isEditing: boolean
  isConfirmingClose: boolean
  onSelect: () => void
  onClose: () => void
  onStartEdit: () => void
  onStopEdit: () => void
  onRename: (newValue: string | null) => void
  onConfirmClose: () => void
  onCancelClose: () => void
  onSetPillColor: (color: string | null) => void
  colorPickerTabId: string | null
  onOpenColorPicker: (tabId: string, anchor: { x: number; y: number }) => void
  onCloseColorPicker: () => void
  onOpenDirMenu: (tabId: string, anchor: { x: number; y: number }) => void
  onCreateTabInDir: (dir: string) => void
  dirMenuTabId: string | null
  onOpenTabMenu: (tabId: string, anchor: { x: number; y: number }) => void
  tabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}) {
  const colors = useColors()
  const gitOpsMode = useThemeStore((s) => s.gitOpsMode)
  const dragControls = useDragControls()
  const dragOrigin = useRef({ x: 0, y: 0 })
  const isDragging = useRef(false)

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const displayTitle = tab.customTitle || tab.title
  const hasCustomTitle = !!tab.customTitle

  // Derive waiting-for-user state from permission denials
  const waitingState: 'plan-ready' | 'question' | null = (() => {
    const tools = tab.permissionDenied?.tools
    if (!tools?.length) return null
    if (tools.some((t) => t.toolName === 'AskUserQuestion')) return 'question'
    if (tools.some((t) => t.toolName === 'ExitPlanMode')) return 'plan-ready'
    return null
  })()

  // Waiting-state border color (thin rim, no boxShadow bleed)
  const waitingBorder = waitingState === 'plan-ready'
    ? colors.tabGlowPlanReady
    : waitingState === 'question'
      ? colors.tabGlowQuestion
      : null

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 1) { e.preventDefault(); if (!isRunning && !tab.bashExecuting) onClose(); return }
    if (e.button !== 0) return
    dragOrigin.current = { x: e.clientX, y: e.clientY }
    isDragging.current = false

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - dragOrigin.current.x
      const dy = moveEvent.clientY - dragOrigin.current.y
      if (!isDragging.current && Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
        isDragging.current = true
        dragControls.start(e.nativeEvent)
      }
    }
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      isDragging.current = false
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }, [dragControls, onClose])

  return (
    <Reorder.Item
      key={tab.id}
      value={tab}
      dragListener={false}
      dragControls={dragControls}
      ref={(el: HTMLDivElement | null) => {
        if (el) tabRefs.current.set(tab.id, el)
        else tabRefs.current.delete(tab.id)
      }}
      initial={false}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.15 }}
      layout
      onClick={() => { if (isDragging.current) return; onCancelClose(); onSelect() }}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onOpenTabMenu(tab.id, { x: e.clientX, y: e.clientY }) }}
      className={`group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 ${
        hasCustomTitle || isEditing || isConfirmingClose ? '' : 'max-w-[160px]'
      } ${waitingBorder ? 'animate-border-pulse' : ''}`}
      style={{
        '--border-waiting': waitingBorder ?? 'transparent',
        '--border-default': tab.pillColor
          ? `${tab.pillColor}${isActive ? '40' : '25'}`
          : isActive ? colors.tabActiveBorder : 'transparent',
        background: tab.pillColor
          ? `${tab.pillColor}${isActive ? '18' : '10'}`
          : isActive ? colors.tabActive : 'transparent',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: waitingBorder
          ?? (tab.pillColor ? `${tab.pillColor}${isActive ? '40' : '25'}` : isActive ? colors.tabActiveBorder : 'transparent'),
        borderRadius: 9999,
        padding: '4px 10px',
        fontSize: 12,
        color: isActive ? colors.textPrimary : colors.textTertiary,
        fontWeight: isActive ? 500 : 400,
      } as React.CSSProperties}
    >
      <span
        className="flex-shrink-0 inline-flex"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onOpenColorPicker(tab.id, { x: e.clientX, y: e.clientY })
        }}
      >
        <StatusDot status={tab.status} hasUnread={tab.hasUnread} hasPermission={tab.permissionQueue.length > 0} bashExecuting={tab.bashExecuting} waitingState={waitingState} />
      </span>
      {tab.forkedFromSessionId && !tab.worktree ? (
        <GitFork size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : tab.worktree ? (
        <GitBranch size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : gitOpsMode === 'worktree' ? (
        <FolderSimple size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : null}
      {tab.workingDirectory && (
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: colors.textSecondary,
            opacity: 0.5,
            cursor: 'default',
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpenDirMenu(tab.id, { x: e.clientX, y: e.clientY })
          }}
        >
          {tab.workingDirectory.split('/').pop() || tab.workingDirectory}
        </span>
      )}
      {isEditing ? (
        <InlineRenameInput
          value={displayTitle}
          color={isActive ? colors.textPrimary : colors.textTertiary}
          fontWeight={isActive ? 500 : 400}
          onCommit={(newValue) => {
            onStopEdit()
            onRename(newValue || null)
          }}
          onCancel={onStopEdit}
        />
      ) : (
        <span
          className={hasCustomTitle ? 'flex-1 whitespace-nowrap' : 'truncate flex-1'}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onStartEdit()
          }}
        >
          {displayTitle}
        </span>
      )}
      {isConfirmingClose ? (
        <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onCancelClose}
            className="px-1 rounded"
            style={{ color: colors.textTertiary }}
          >
            No
          </button>
          <button
            onClick={() => { onClose(); onCancelClose() }}
            className="px-1 rounded"
            style={{ color: colors.accent }}
          >
            Yes
          </button>
        </div>
      ) : !isRunning && (
        <button
          onClick={(e) => { e.stopPropagation(); onConfirmClose() }}
          className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center transition-opacity"
          style={{
            opacity: isActive ? 0.5 : 0,
            color: colors.textSecondary,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = isActive ? '0.5' : '0' }}
        >
          <X size={10} />
        </button>
      )}
    </Reorder.Item>
  )
}

export function TabStrip() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const selectTab = useSessionStore((s) => s.selectTab)
  const createTab = useSessionStore((s) => s.createTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const reorderTabs = useSessionStore((s) => s.reorderTabs)
  const renameTab = useSessionStore((s) => s.renameTab)
  const setTabPillColor = useSessionStore((s) => s.setTabPillColor)
  const createTabInDirectory = useSessionStore((s) => s.createTabInDirectory)
  const toggleTerminal = useSessionStore((s) => s.toggleTerminal)
  const terminalOpenTabIds = useSessionStore((s) => s.terminalOpenTabIds)
  const colors = useColors()
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const toggleExpanded = useSessionStore((s) => s.toggleExpanded)
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const { mode: groupMode, groups, ungrouped } = useTabGroups()

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)
  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirMenuTabId, setDirMenuTabId] = useState<string | null>(null)
  const [dirMenuAnchor, setDirMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [recentDirsMenu, setRecentDirsMenu] = useState<{ x: number; y: number } | null>(null)
  const [tabMenuId, setTabMenuId] = useState<string | null>(null)
  const [tabMenuAnchor, setTabMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [worktreeCloseTabId, setWorktreeCloseTabId] = useState<string | null>(null)
  const [worktreeCloseStatus, setWorktreeCloseStatus] = useState<WorktreeStatus | null>(null)
  const plusButtonRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Scroll the confirming-close tab into view after it expands
  useEffect(() => {
    if (!confirmingCloseId) return
    requestAnimationFrame(() => {
      const el = tabRefs.current.get(confirmingCloseId)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
  }, [confirmingCloseId])

  // Listen for CMD+R "open recent dirs" event from App
  useEffect(() => {
    const handler = () => {
      if (!plusButtonRef.current) return
      const rect = plusButtonRef.current.getBoundingClientRect()
      setRecentDirsMenu({ x: rect.left, y: rect.bottom })
    }
    window.addEventListener('coda:open-recent-dirs', handler)
    return () => window.removeEventListener('coda:open-recent-dirs', handler)
  }, [])

  // Convert vertical wheel to horizontal scroll
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!scrollRef.current || e.deltaY === 0) return
    e.preventDefault()
    scrollRef.current.scrollLeft += e.deltaY
  }, [])

  if (!tabsReady) {
    return <div data-coda-ui className="flex items-center no-drag" style={{ padding: '8px 0', height: 40 }} />
  }

  return (
    <div
      data-coda-ui
      className="flex items-center no-drag"
      style={{ padding: '8px 0' }}
    >
      {/* Minimize / maximize toggle */}
      <button
        onClick={toggleExpanded}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ml-1"
        style={{ color: isExpanded ? colors.textTertiary : colors.accent }}
        title={isExpanded ? 'Minimize (Cmd+J)' : 'Maximize (Cmd+K)'}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = colors.textPrimary }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = isExpanded ? colors.textTertiary : colors.accent }}
      >
        {isExpanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
      </button>

      {/* Scrollable tabs area — clipped by master card edge */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          className="overflow-x-auto min-w-0"
          onWheel={onWheel}
          style={{
            scrollbarWidth: 'none',
            paddingLeft: 8,
            paddingRight: 14,
            maskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
          }}
        >
          {(() => {
            const renderTabPill = (tab: TabState) => (
              <TabPill
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                isEditing={editingTabId === tab.id}
                isConfirmingClose={confirmingCloseId === tab.id}
                onSelect={() => selectTab(tab.id)}
                onClose={() => {
                  if (tab.worktree) {
                    setWorktreeCloseTabId(tab.id)
                    setWorktreeCloseStatus(null)
                    window.coda.gitWorktreeStatus(tab.worktree.worktreePath, tab.worktree.sourceBranch)
                      .then((status) => setWorktreeCloseStatus(status))
                      .catch(() => setWorktreeCloseStatus({ hasUncommittedChanges: false, hasUnpushedCommits: false, isMerged: false, aheadCount: 0, behindCount: 0 }))
                  } else {
                    closeTab(tab.id)
                  }
                }}
                onStartEdit={() => setEditingTabId(tab.id)}
                onStopEdit={() => setEditingTabId(null)}
                onRename={(newValue) => renameTab(tab.id, newValue)}
                onConfirmClose={() => {
                  if (tab.worktree) {
                    setWorktreeCloseTabId(tab.id)
                    setWorktreeCloseStatus(null)
                    window.coda.gitWorktreeStatus(tab.worktree.worktreePath, tab.worktree.sourceBranch)
                      .then((status) => setWorktreeCloseStatus(status))
                      .catch(() => setWorktreeCloseStatus({ hasUncommittedChanges: false, hasUnpushedCommits: false, isMerged: false, aheadCount: 0, behindCount: 0 }))
                  } else {
                    setConfirmingCloseId(tab.id)
                  }
                }}
                onCancelClose={() => setConfirmingCloseId(null)}
                onSetPillColor={(color) => setTabPillColor(tab.id, color)}
                colorPickerTabId={colorPickerTabId}
                onOpenColorPicker={(tabId, anchor) => { setColorPickerTabId(tabId); setColorPickerAnchor(anchor) }}
                onCloseColorPicker={() => setColorPickerTabId(null)}
                onOpenDirMenu={(tabId, anchor) => { setDirMenuTabId(tabId); setDirMenuAnchor(anchor) }}
                onCreateTabInDir={(dir) => createTabInDirectory(dir, shouldUseWorktree(false))}
                dirMenuTabId={dirMenuTabId}
                onOpenTabMenu={(tabId, anchor) => { setTabMenuId(tabId); setTabMenuAnchor(anchor) }}
                tabRefs={tabRefs}
              />
            )

            if (groupMode === 'off') {
              // Original flat tab rendering
              return (
                <Reorder.Group
                  as="div"
                  axis="x"
                  values={tabs}
                  onReorder={reorderTabs}
                  className="flex items-center gap-1"
                  layoutScroll
                >
                  {tabs.map(renderTabPill)}
                </Reorder.Group>
              )
            }

            // Grouped rendering: groups in one Reorder.Group, ungrouped tabs in another
            const groupIds = groups.map((g) => g.groupId)

            return (
              <div className="flex items-center gap-1">
                <Reorder.Group
                  as="div"
                  axis="x"
                  values={groupIds}
                  onReorder={(reorderedIds) => {
                    if (groupMode === 'manual') {
                      const reorderedTabGroups = reorderedIds.map((id) => {
                        const stored = useThemeStore.getState().tabGroups.find((sg) => sg.id === id)
                        const view = groups.find((g) => g.groupId === id)
                        return stored || { id, label: view?.label || id, isDefault: view?.isDefault || false, order: 0, collapsed: view?.collapsed || false }
                      })
                      useThemeStore.getState().reorderTabGroups(reorderedTabGroups)
                    } else if (groupMode === 'auto') {
                      const dirs = reorderedIds.map((id) => id.replace('auto-', ''))
                      useThemeStore.getState().setAutoGroupOrder(dirs)
                    }
                  }}
                  className="flex items-center gap-1"
                  layoutScroll
                >
                  {groups.map((group) => {
                    const isGroupActive = group.tabs.some((t) => t.id === activeTabId)
                    return (
                      <Reorder.Item key={group.groupId} value={group.groupId} as="div" style={{ listStyle: 'none' }}>
                        <GroupPill
                          group={group}
                          isActive={isGroupActive}
                          onSelect={(tabId) => selectTab(tabId)}
                        />
                      </Reorder.Item>
                    )
                  })}
                </Reorder.Group>
                {ungrouped.length > 0 && (
                  <Reorder.Group
                    as="div"
                    axis="x"
                    values={ungrouped}
                    onReorder={(reordered) => {
                      const ungroupedOrder = new Map(reordered.map((t, i) => [t.id, i]))
                      const result = [...tabs].sort((a, b) => {
                        const aIdx = ungroupedOrder.get(a.id)
                        const bIdx = ungroupedOrder.get(b.id)
                        if (aIdx != null && bIdx != null) return aIdx - bIdx
                        return 0
                      })
                      reorderTabs(result)
                    }}
                    className="flex items-center gap-1"
                    layoutScroll
                  >
                    {ungrouped.map(renderTabPill)}
                  </Reorder.Group>
                )}
              </div>
            )
          })()}
        </div>
      </div>

      <AnimatePresence>
        {colorPickerTabId && (() => {
          const pickerTab = tabs.find((t) => t.id === colorPickerTabId)
          if (!pickerTab) return null
          return (
            <PillColorPicker
              key="pill-color-picker"
              anchor={colorPickerAnchor}
              currentColor={pickerTab.pillColor}
              onSelect={(color) => setTabPillColor(colorPickerTabId, color)}
              onClose={() => setColorPickerTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {dirMenuTabId && (() => {
          const menuTab = tabs.find((t) => t.id === dirMenuTabId)
          if (!menuTab?.workingDirectory) return null
          const dirName = menuTab.workingDirectory.split('/').pop() || menuTab.workingDirectory
          return (
            <DirContextMenu
              key="dir-context-menu"
              anchor={dirMenuAnchor}
              dirName={dirName}
              tabId={menuTab.id}
              tabGroupId={menuTab.groupId || undefined}
              onCreateTab={() => createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))}
              onForkTab={menuTab.claudeSessionId ? () => { useSessionStore.getState().forkTab(menuTab.id) } : undefined}
              onFinishWork={menuTab.worktree ? () => { useSessionStore.getState().finishWorktreeTab(menuTab.id) } : undefined}
              onClose={() => setDirMenuTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {recentDirsMenu && (
          <RecentDirsContextMenu
            key="recent-dirs-menu"
            anchor={recentDirsMenu}
            onSelectDir={(dir, altKey) => createTabInDirectory(dir, shouldUseWorktree(altKey))}
            onClose={() => setRecentDirsMenu(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tabMenuId && (() => {
          const menuTab = tabs.find((t) => t.id === tabMenuId)
          if (!menuTab) return null
          return (
            <TabContextMenu
              key="tab-context-menu"
              anchor={tabMenuAnchor}
              tab={menuTab}
              onForkTab={menuTab.claudeSessionId ? () => { useSessionStore.getState().forkTab(menuTab.id) } : undefined}
              onNewTabInDir={() => {
                if (menuTab.workingDirectory) createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))
              }}
              onFinishWork={() => {
                useSessionStore.getState().finishWorktreeTab(menuTab.id)
              }}
              onClose={() => setTabMenuId(null)}
            />
          )
        })()}
      </AnimatePresence>

      {worktreeCloseTabId && worktreeCloseStatus && (() => {
        const wtTab = tabs.find((t) => t.id === worktreeCloseTabId)
        if (!wtTab) return null
        const strategy = useThemeStore.getState().worktreeCompletionStrategy
        return (
          <WorktreeCloseDialog
            uncommittedCount={worktreeCloseStatus.hasUncommittedChanges ? 1 : 0}
            unpushedCount={worktreeCloseStatus.aheadCount}
            defaultStrategy={strategy}
            onFinish={(s) => {
              useSessionStore.getState().finishWorktreeTab(worktreeCloseTabId, s)
              setWorktreeCloseTabId(null)
              setWorktreeCloseStatus(null)
            }}
            onDiscard={() => {
              closeTab(worktreeCloseTabId)
              setWorktreeCloseTabId(null)
              setWorktreeCloseStatus(null)
            }}
            onCancel={() => {
              setWorktreeCloseTabId(null)
              setWorktreeCloseStatus(null)
            }}
          />
        )
      })()}

      {(() => {
        const activeTab = tabs.find((t) => t.id === activeTabId)
        if (!activeTab?.pendingWorktreeSetup) return null
        return (
          <BranchPickerDialog
            repoPath={activeTab.workingDirectory}
            onSelect={(branch, setAsDefault) => {
              useSessionStore.getState().setupWorktree(activeTab.id, branch, setAsDefault)
            }}
            onCancel={() => {
              useSessionStore.getState().cancelWorktreeSetup(activeTab.id)
            }}
          />
        )
      })()}

      {/* Pinned action buttons — always visible on the right */}
      <div className="flex items-center gap-0.5 flex-shrink-0 ml-1 pr-2">
        <button
          ref={plusButtonRef}
          onClick={(e) => createTab(shouldUseWorktree(e.altKey))}
          onContextMenu={(e) => { e.preventDefault(); setRecentDirsMenu({ x: e.clientX, y: e.clientY }) }}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="New tab (right-click for recent dirs)"
        >
          <Plus size={14} />
        </button>

        <button
          onClick={() => toggleTerminal(activeTabId)}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: terminalOpenTabIds.has(activeTabId) ? colors.accent : colors.textTertiary }}
          title="Toggle terminal"
        >
          <Terminal size={14} />
        </button>

        <HistoryPicker />

        <SettingsPopover />
      </div>
    </div>
  )
}
