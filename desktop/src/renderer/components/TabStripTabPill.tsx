import React, { useCallback } from 'react'
import { X, GitBranch, GitFork, FolderSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import type { TabState } from '../../shared/types'
import { getWaitingState } from './TabStripShared'
import { StatusDot } from './TabStripStatusDot'
import { InlineRenameInput } from './TabStripInlineRenameInput'

interface TabPillProps {
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
  onDragPointerDown: (key: string, e: React.PointerEvent) => void
  isDraggingRef: React.RefObject<boolean>
}

/** A single (un-grouped) tab pill rendered in the flat tab strip. Owns interaction (select, close, drag, context menus) but not the popovers themselves — the parent renders those. */
export function TabPill({
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
  onOpenColorPicker,
  onOpenDirMenu,
  onOpenTabMenu,
  tabRefs,
  onDragPointerDown,
  isDraggingRef,
}: TabPillProps) {
  const colors = useColors()
  const gitOpsMode = usePreferencesStore((s) => s.gitOpsMode)

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const displayTitle = tab.customTitle || tab.title

  // Derive waiting-for-user state from permission denials
  const waitingState = getWaitingState(tab)

  // Waiting-state border color (thin rim, no boxShadow bleed)
  const waitingBorder = waitingState === 'plan-ready'
    ? colors.tabGlowPlanReady
    : waitingState === 'question'
      ? colors.tabGlowQuestion
      : null

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === 1) { e.preventDefault(); if (!tab.worktree && !isRunning && !tab.bashExecuting) onClose(); return }
    if (e.button !== 0) return
    onDragPointerDown(tab.id, e)
  }, [onClose, onDragPointerDown, tab.id, tab.worktree, tab.bashExecuting, isRunning])

  return (
    <div
      ref={(el: HTMLDivElement | null) => {
        if (el) tabRefs.current.set(tab.id, el)
        else tabRefs.current.delete(tab.id)
      }}
      style={{ flexShrink: 0 }}
    >
      <div
        onClick={() => { if (isDraggingRef.current) return; onCancelClose(); onSelect() }}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onOpenTabMenu(tab.id, { x: e.clientX, y: e.clientY }) }}
        className={`group flex items-center gap-1.5 cursor-pointer select-none ${
          isEditing || isConfirmingClose ? '' : 'max-w-[240px]'
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
        <StatusDot status={tab.status} hasUnread={tab.hasUnread} hasPermission={tab.permissionQueue.length > 0} bashExecuting={tab.bashExecuting} waitingState={waitingState} pillIcon={tab.pillIcon} />
      </span>
      {tab.forkedFromSessionId && !tab.worktree ? (
        <GitFork size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : tab.worktree ? (
        <GitBranch size={11} color="#4ade80" style={{ opacity: 0.7 }} className="flex-shrink-0" />
      ) : gitOpsMode === 'worktree' ? (
        <FolderSimple size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : null}
      {tab.workingDirectory && (
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: tab.worktree ? '#4ade80' : colors.textSecondary,
            opacity: tab.worktree ? 0.6 : 0.5,
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
          className="truncate flex-1"
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onStartEdit()
          }}
        >
          {displayTitle}
        </span>
      )}
      {tab.worktree ? null : isConfirmingClose ? (
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
      </div>
    </div>
  )
}
