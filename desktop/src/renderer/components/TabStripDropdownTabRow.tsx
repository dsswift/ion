import React, { useRef, useCallback } from 'react'
import { Reorder, useDragControls } from 'framer-motion'
import { X, PencilSimple, PushPin } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import type { TabState } from '../../shared/types'
import { PILL_ICON_MAP, getTabStatusColor, getWaitingState, abbreviateProfileName } from './TabStripShared'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
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
  // Row pointer state — this component is already one-instance-per-row, so
  // the hook is legal here (no hooks in loops in the parent).
  const { hover, pressed, handlers } = useInteractiveState()

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

  // Harness badge label — mirrors the pill's subscription. Subscribe narrowly
  // so the row only re-renders when engine profiles change, not on every
  // preference write.
  const harnessBadgeLabel = usePreferencesStore((s) => {
    if (!tab.engineProfileId) return null
    const profile = s.engineProfiles.find((p) => p.id === tab.engineProfileId)
    return abbreviateProfileName(profile?.name)
  })

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
        // Standard row cascade (pressed > hover > selected > base) via
        // interactiveBg; a user pill color keeps the runtime `${pillColor}NN`
        // alpha-concat pattern, deepening 10 → 18 on hover.
        background: tab.pillColor
          ? `${tab.pillColor}${isActive || hover ? '18' : '10'}`
          : interactiveBg(colors, { hover, pressed, selected: isActive }),
        borderLeft: `2px solid ${waitingBorder ?? defaultBorder}`,
        fontSize: 12,
        fontWeight: isActive ? 500 : 400,
        listStyle: 'none',
        transition: `background ${transitions.base}`,
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
      {...handlers}
      onMouseDown={(e) => {
        // Merge with the pointer-state hook: mark pressed, then run the
        // existing middle-click close (semantics unchanged).
        handlers.onMouseDown()
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

      {harnessBadgeLabel !== null && (
        // Harness badge: abbreviated profile name in an accent-tinted chip.
        // Mirrors the pill's badge element exactly — same style spec:
        // 4px radius, accent bg/border/text at 25/40/100% opacity, 9px/600 weight.
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: colors.accent,
            background: `${colors.accent}25`,
            border: `1px solid ${colors.accent}40`,
            borderRadius: 4,
            padding: '1px 3px',
            lineHeight: 1.4,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          {harnessBadgeLabel}
        </span>
      )}

      {tab.workingDirectory && (
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: tab.worktree ? colors.worktreeGreen : colors.textSecondary,
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

      {tab.groupPinned && (
        <PushPin size={10} color={colors.textTertiary} className="flex-shrink-0" style={{ opacity: 0.7 }} />
      )}

      <button
        onClick={(e) => { e.stopPropagation(); setEditingTabId(tab.id) }}
        className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center ion-focusable"
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
            className="px-1 rounded ion-focusable"
            style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            No
          </button>
          <button
            onClick={() => { onCloseTab(tab.id); setConfirmingCloseId(null) }}
            className="px-1 rounded ion-focusable"
            style={{ color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Yes
          </button>
        </div>
      ) : !isRunning && (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmingCloseId(tab.id) }}
          className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center ion-focusable"
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
