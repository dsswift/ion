import React, { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import { Plus, X } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { useColors, useThemeStore } from '../theme'
import type { TabStatus, TabState } from '../../shared/types'

function StatusDot({ status, hasUnread, hasPermission }: { status: TabStatus; hasUnread: boolean; hasPermission: boolean }) {
  const colors = useColors()
  let bg: string = colors.statusIdle
  let pulse = false
  let glow = false

  if (status === 'dead' || status === 'failed') {
    bg = colors.statusError
  } else if (hasPermission) {
    bg = colors.statusPermission
    glow = true
  } else if (status === 'connecting' || status === 'running') {
    bg = colors.statusRunning
    pulse = true
  } else if (hasUnread) {
    bg = colors.statusComplete
  }

  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${colors.statusPermissionGlow}` } : {}),
      }}
    />
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
  tabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}) {
  const colors = useColors()
  const dragControls = useDragControls()
  const dragOrigin = useRef({ x: 0, y: 0 })
  const isDragging = useRef(false)

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const displayTitle = tab.customTitle || tab.title
  const hasCustomTitle = !!tab.customTitle

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 1) { e.preventDefault(); onClose(); return }
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
      className={`group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 ${
        hasCustomTitle || isEditing || isConfirmingClose ? '' : 'max-w-[160px]'
      }`}
      style={{
        background: isActive ? colors.tabActive : 'transparent',
        border: isActive ? `1px solid ${colors.tabActiveBorder}` : '1px solid transparent',
        borderRadius: 9999,
        padding: '4px 10px',
        fontSize: 12,
        color: isActive ? colors.textPrimary : colors.textTertiary,
        fontWeight: isActive ? 500 : 400,
      }}
    >
      <StatusDot status={tab.status} hasUnread={tab.hasUnread} hasPermission={tab.permissionQueue.length > 0} />
      {showDirLabel && tab.workingDirectory && (
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: colors.textSecondary,
            opacity: 0.5,
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
  const colors = useColors()
  const showDirLabel = useThemeStore((s) => s.showDirLabel)
  const tabsReady = useSessionStore((s) => s.tabsReady)

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)
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

  // Convert vertical wheel to horizontal scroll
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!scrollRef.current || e.deltaY === 0) return
    e.preventDefault()
    scrollRef.current.scrollLeft += e.deltaY
  }, [])

  if (!tabsReady) {
    return <div data-clui-ui className="flex items-center no-drag" style={{ padding: '8px 0', height: 40 }} />
  }

  return (
    <div
      data-clui-ui
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
                onClose={() => closeTab(tab.id)}
                onStartEdit={() => setEditingTabId(tab.id)}
                onStopEdit={() => setEditingTabId(null)}
                onRename={(newValue) => renameTab(tab.id, newValue)}
                onConfirmClose={() => setConfirmingCloseId(tab.id)}
                onCancelClose={() => setConfirmingCloseId(null)}
                tabRefs={tabRefs}
              />
            ))}
          </Reorder.Group>
        </div>
      </div>

      {/* Pinned action buttons — always visible on the right */}
      <div className="flex items-center gap-0.5 flex-shrink-0 ml-1 pr-2">
        <button
          onClick={() => createTab()}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="New tab"
        >
          <Plus size={14} />
        </button>

        <HistoryPicker />

        <SettingsPopover />
      </div>
    </div>
  )
}
