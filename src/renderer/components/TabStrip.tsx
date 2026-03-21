import React, { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { useColors, useThemeStore } from '../theme'
import type { TabStatus } from '../../shared/types'

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

export function TabStrip() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const selectTab = useSessionStore((s) => s.selectTab)
  const createTab = useSessionStore((s) => s.createTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const renameTab = useSessionStore((s) => s.renameTab)
  const colors = useColors()
  const showDirLabel = useThemeStore((s) => s.showDirLabel)

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)

  return (
    <div
      data-clui-ui
      className="flex items-center no-drag"
      style={{ padding: '8px 0' }}
    >
      {/* Scrollable tabs area — clipped by master card edge */}
      <div className="relative min-w-0 flex-1">
        <div
          className="flex items-center gap-1 overflow-x-auto min-w-0"
          style={{
            scrollbarWidth: 'none',
            paddingLeft: 8,
            // Extra right breathing room so clipped tabs fade out before the edge.
            paddingRight: 14,
            // Right-only content fade so the parent card's own animated background
            // shows through cleanly in both collapsed and expanded states.
            maskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
          }}
        >
          <AnimatePresence mode="popLayout">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId
              const isEditing = editingTabId === tab.id
              const isConfirmingClose = confirmingCloseId === tab.id
              const isRunning = tab.status === 'running' || tab.status === 'connecting'
              const displayTitle = tab.customTitle || tab.title
              const hasCustomTitle = !!tab.customTitle
              return (
                <motion.div
                  key={tab.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => { setConfirmingCloseId(null); selectTab(tab.id) }}
                  className={`group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 transition-all duration-150 ${
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
                        setEditingTabId(null)
                        renameTab(tab.id, newValue || null)
                      }}
                      onCancel={() => setEditingTabId(null)}
                    />
                  ) : (
                    <span
                      className={hasCustomTitle ? 'flex-1 whitespace-nowrap' : 'truncate flex-1'}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setEditingTabId(tab.id)
                      }}
                    >
                      {displayTitle}
                    </span>
                  )}
                  {isConfirmingClose ? (
                    <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setConfirmingCloseId(null)}
                        className="px-1 rounded"
                        style={{ color: colors.textTertiary }}
                      >
                        No
                      </button>
                      <button
                        onClick={() => { closeTab(tab.id); setConfirmingCloseId(null) }}
                        className="px-1 rounded"
                        style={{ color: colors.accent }}
                      >
                        Yes
                      </button>
                    </div>
                  ) : !isRunning && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmingCloseId(tab.id) }}
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
                </motion.div>
              )
            })}
          </AnimatePresence>
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
