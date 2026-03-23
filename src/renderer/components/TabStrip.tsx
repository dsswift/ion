import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import { Plus, X, Prohibit, Terminal, FolderPlus, FolderOpen, GitBranch, FolderSimple, CheckCircle } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { WorktreeCloseDialog } from './WorktreeCloseDialog'
import { BranchPickerDialog } from './BranchPickerDialog'
import { usePopoverLayer } from './PopoverLayer'
import { useColors, useThemeStore } from '../theme'
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

function StatusDot({ status, hasUnread, hasPermission, bashExecuting }: { status: TabStatus; hasUnread: boolean; hasPermission: boolean; bashExecuting: boolean }) {
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
  onCreateTab,
  onClose,
}: {
  anchor: { x: number; y: number }
  dirName: string
  onCreateTab: () => void
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
    </motion.div>,
    popoverLayer,
  )
}

function TabContextMenu({
  anchor,
  tab,
  onCloneTab,
  onNewTabInDir,
  onFinishWork,
  onClose,
}: {
  anchor: { x: number; y: number }
  tab: TabState
  onCloneTab: () => void
  onNewTabInDir: () => void
  onFinishWork: () => void
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
      {tab.workingDirectory && (
        <>
          <button
            onClick={() => { onCloneTab(); onClose() }}
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={menuItemStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <FolderPlus size={14} color={colors.textSecondary} />
            <span>Clone tab</span>
          </button>
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
        </>
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
            <button
              key={dir}
              onClick={(e) => { onSelectDir(dir, e.altKey); onClose() }}
              className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
              style={{
                fontSize: 12,
                color: colors.textPrimary,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              title={dir}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <FolderOpen size={14} color={colors.textSecondary} style={{ flexShrink: 0 }} />
              <span style={{ whiteSpace: 'nowrap' }}>{displayPath}</span>
            </button>
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

const DRAG_THRESHOLD = 8

function TabPill({
  tab,
  isActive,
  isEditing,
  isConfirmingClose,
  showDirLabel,
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
  showDirLabel: boolean
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
      }`}
      style={{
        background: isActive ? colors.tabActive : 'transparent',
        border: tab.pillColor
          ? `1px solid ${tab.pillColor}${isActive ? '' : '80'}`
          : isActive ? `1px solid ${colors.tabActiveBorder}` : '1px solid transparent',
        borderRadius: 9999,
        padding: '4px 10px',
        fontSize: 12,
        color: isActive ? colors.textPrimary : colors.textTertiary,
        fontWeight: isActive ? 500 : 400,
      }}
    >
      <span
        className="flex-shrink-0 inline-flex"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onOpenColorPicker(tab.id, { x: e.clientX, y: e.clientY })
        }}
      >
        <StatusDot status={tab.status} hasUnread={tab.hasUnread} hasPermission={tab.permissionQueue.length > 0} bashExecuting={tab.bashExecuting} />
      </span>
      {tab.worktree ? (
        <GitBranch size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : gitOpsMode === 'worktree' ? (
        <FolderSimple size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : null}
      {showDirLabel && tab.workingDirectory && (
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
  const showDirLabel = useThemeStore((s) => s.showDirLabel)
  const tabsReady = useSessionStore((s) => s.tabsReady)

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
          <Reorder.Group
            as="div"
            axis="x"
            values={tabs}
            onReorder={reorderTabs}
            className="flex items-center gap-1"
            layoutScroll
          >
            {tabs.map((tab) => (
              <TabPill
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                isEditing={editingTabId === tab.id}
                isConfirmingClose={confirmingCloseId === tab.id}
                showDirLabel={showDirLabel}
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
                    // Worktree tab: show the WorktreeCloseDialog instead of inline confirmation
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
            ))}
          </Reorder.Group>
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
              onCreateTab={() => createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))}
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
              onCloneTab={() => {
                if (menuTab.workingDirectory) createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))
              }}
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
