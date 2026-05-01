import React, { useRef, useCallback } from 'react'
import { Reorder, useDragControls } from 'framer-motion'
import { X, PencilSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { TabState } from '../../shared/types'
import { PILL_ICON_MAP, getTabStatusColor, getWaitingState } from './TabStripShared'
import { InlineRenameInput } from './TabStripInlineRenameInput'

const DROPDOWN_DRAG_THRESHOLD = 8

interface DropdownTabRowProps {
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
}

/** A single row inside the group picker dropdown. Owns its drag controls so the parent can use Reorder.Group. */
export function DropdownTabRow({
  tab,
  isActive,
  colors,
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
}: DropdownTabRowProps) {
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

  const waitingState = getWaitingState(tab)

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
          if (!tab.worktree && !isRunning && !tab.bashExecuting) onCloseTab(tab.id)
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
        {tab.pillIcon && PILL_ICON_MAP[tab.pillIcon] ? (() => {
          const Icon = PILL_ICON_MAP[tab.pillIcon!]
          return (
            <span
              className={`flex-shrink-0 inline-flex items-center justify-center ${pulse ? 'animate-pulse-dot' : ''}`}
              style={{ width: 8, height: 8, ...(glow ? { filter: `drop-shadow(0 0 4px ${glowColor})` } : {}) }}
            >
              <Icon size={8} weight="fill" color={bg} />
            </span>
          )
        })() : (
          <span
            className={`w-[6px] h-[6px] rounded-full ${pulse ? 'animate-pulse-dot' : ''}`}
            style={{
              background: bg,
              ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
            }}
          />
        )}
      </span>

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
        >
          {displayTitle}
        </span>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); setEditingTabId(tab.id) }}
        className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center"
        style={{ opacity: 0.5, color: colors.textSecondary, background: 'none', border: 'none', cursor: 'pointer' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
      >
        <PencilSimple size={10} />
      </button>

      {tab.worktree ? null : isConfirming ? (
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
