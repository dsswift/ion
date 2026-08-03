import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Plus, CaretDown, Rows, ArrowRight } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore, getEffectiveTabGroups } from '../preferences'
import type { TabGroupView } from '../hooks/useTabGroups'
import type { TabGroupMode } from '../../shared/types-session'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { zoomRect, zoomViewport } from '../viewport-zoom'
import { ContextMenuItem } from './ContextMenuItem'
import { ConfirmDialog } from './git/ConfirmDialog'
import { rDebug, rInfo } from '../rendererLogger'

interface InactiveGroupMenuProps {
  anchor: { x: number; y: number }
  group: TabGroupView
  onClose: () => void
}

/** Right-click context menu for an inactive (non-selected) group pill. Lets the user move all tabs in the group to another group. */
export function InactiveGroupMenu({
  anchor,
  group,
  onClose,
}: InactiveGroupMenuProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  const tabGroups = usePreferencesStore((s) => s.tabGroups)
  const moveTabToGroup = useSessionStore((s) => s.moveTabToGroup)
  const [moveSubmenu, setMoveSubmenu] = useState<{ x: number; y: number } | null>(null)
  // Bounding rect of the "Move all to group" row that triggered the
  // submenu — passed to the submenu's positioning hook so it can
  // flip to the left of the parent row when the right side overflows.
  const [moveParentRect, setMoveParentRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [pendingMoveAll, setPendingMoveAll] = useState<{ groupId: string; label: string } | null>(null)

  // Confirm dialogs are exempted structurally by the hook (via
  // `[data-ion-confirm]`), so this menu no longer threads a ref for them.
  const dismiss = useCallback(() => { setMoveSubmenu(null); onClose() }, [onClose])
  useOutsideDismiss([ref, submenuRef], dismiss)

  useEffect(() => {
    if (showNewGroupInput) inputRef.current?.focus()
  }, [showNewGroupInput])

  // Build available targets — computed before the early-return so we
  // can include `targets.length` in the positioning hook's deps.
  const effectiveGroups = getEffectiveTabGroups(tabGroups)
  const targets = effectiveGroups
    .filter((g) => g.id !== group.groupId)
    .map((g) => ({ id: g.id, label: g.label }))

  // Outer menu position — flips upward when the click anchor is
  // near the bottom of a short window. The submenu may not change
  // outer height (it's portaled), but we still re-measure on the
  // few toggles that *could* (none today; this keeps the deps
  // future-proof).
  const outerPos = useAnchoredPopover(anchor, {
    prefer: 'below',
    deps: [tabGroupMode, moveSubmenu],
  })
  const vp = zoomViewport()

  if (!popoverLayer) return null

  const requestMoveAll = (targetGroupId: string, targetLabel: string) => {
    rDebug('inactive-group-menu', 'move-all confirmation requested', { tab_count: group.tabs.length, target_group: targetGroupId, target_label: targetLabel })
    setMoveSubmenu(null)
    setMoveParentRect(null)
    setPendingMoveAll({ groupId: targetGroupId, label: targetLabel })
  }

  return createPortal(
    <>
      <motion.div
        ref={(node) => { (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; outerPos.ref(node) }}
        data-ion-ui
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.12 }}
        style={{
          position: 'fixed',
          left: outerPos.left,
          top: outerPos.top,
          visibility: outerPos.ready ? 'visible' : 'hidden',
          maxHeight: vp.height - 16,
          overflowY: 'auto',
          pointerEvents: 'auto',
          background: colors.popoverBg,
          border: `1px solid ${colors.popoverBorder}`,
          borderRadius: 8,
          padding: 4,
          zIndex: 10000,
          minWidth: 160,
        }}
      >
      <ContextMenuItem
        ref={moveItemRef}
        onHoverStart={() => {
          if (moveItemRef.current) {
            const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
            setMoveSubmenu({ x: rect.right, y: rect.top })
            setMoveParentRect({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
          }
        }}
        onClick={() => {
          if (moveItemRef.current) {
            const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
            setMoveSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
            setMoveParentRect((prev) => prev ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
          }
        }}
      >
        <Rows size={14} color={colors.textSecondary} />
        <span>Move all to group</span>
        <CaretDown size={10} color={colors.textTertiary} style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />
      </ContextMenuItem>
      {moveSubmenu && (
        <InactiveGroupMoveAllSubmenu
          anchor={moveSubmenu}
          parentRect={moveParentRect ?? undefined}
          submenuRef={submenuRef}
          popoverLayer={popoverLayer}
          colors={colors}
          targets={targets}
          tabGroupMode={tabGroupMode}
          showNewGroupInput={showNewGroupInput}
          setShowNewGroupInput={setShowNewGroupInput}
          inputRef={inputRef}
          newGroupName={newGroupName}
          setNewGroupName={setNewGroupName}
          onPickTarget={requestMoveAll}
        />
      )}
      </motion.div>
      {pendingMoveAll && (
        <ConfirmDialog
          title="Move all tabs?"
          message={`Move all ${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''} to "${pendingMoveAll.label}"? This will move every tab in the current group.`}
          confirmLabel="Move all"
          cancelLabel="Cancel"
          danger={false}
          onConfirm={() => {
            rInfo('inactive-group-menu', 'move-all confirmed', { tab_count: group.tabs.length, target_group: pendingMoveAll.groupId, target_label: pendingMoveAll.label })
            for (const tab of group.tabs) moveTabToGroup(tab.id, pendingMoveAll.groupId)
            setPendingMoveAll(null)
            onClose()
          }}
          onCancel={() => {
            rDebug('inactive-group-menu', 'move-all cancelled', { tab_count: group.tabs.length, target_group: pendingMoveAll.groupId, target_label: pendingMoveAll.label })
            setPendingMoveAll(null)
            onClose()
          }}
        />
      )}
    </>,
    popoverLayer,
  )
}

interface InactiveGroupMoveAllSubmenuProps {
  anchor: { x: number; y: number }
  parentRect?: { left: number; right: number; top: number; bottom: number }
  submenuRef: React.RefObject<HTMLDivElement | null>
  popoverLayer: HTMLDivElement
  colors: ReturnType<typeof useColors>
  targets: ReadonlyArray<{ id: string; label: string }>
  tabGroupMode: TabGroupMode
  showNewGroupInput: boolean
  setShowNewGroupInput: (v: boolean) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  newGroupName: string
  setNewGroupName: (v: string) => void
  onPickTarget: (groupId: string, label: string) => void
}

/**
 * Move-all submenu used by `InactiveGroupMenu`. Identical structure
 * to the inline submenu in `TabContextMenu`, but extracted into its
 * own component so it can call `useAnchoredPopover` (hooks
 * cannot run inside a conditional in the parent's render). Manages
 * its own portal and position.
 *
 * `showNewGroupInput` is in the positioning hook's deps because
 * expanding the inline "New group..." input grows the submenu and
 * the row could otherwise drop off the bottom edge.
 */
function InactiveGroupMoveAllSubmenu({
  anchor,
  parentRect,
  submenuRef,
  popoverLayer,
  colors,
  targets,
  tabGroupMode,
  showNewGroupInput,
  setShowNewGroupInput,
  inputRef,
  newGroupName,
  setNewGroupName,
  onPickTarget,
}: InactiveGroupMoveAllSubmenuProps) {
  const vp = zoomViewport()
  const pos = useAnchoredPopover(anchor, {
    prefer: 'rightOf',
    parentRect,
    deps: [showNewGroupInput, targets.length, tabGroupMode],
  })
  return createPortal(
    <motion.div
      ref={(node) => {
        (submenuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.1 }}
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
        zIndex: 10001,
        minWidth: 160,
      }}
    >
      <div className="px-2 py-1 text-[10px] font-medium" style={{ color: colors.textTertiary }}>
        Move all to group
      </div>
      {targets.map((t) => (
        <ContextMenuItem key={t.id} onClick={() => onPickTarget(t.id, t.label)}>
          <ArrowRight size={12} color={colors.textTertiary} />
          <span>{t.label}</span>
        </ContextMenuItem>
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
                    const trimmed = newGroupName.trim()
                    const id = usePreferencesStore.getState().createTabGroup(trimmed)
                    onPickTarget(id, trimmed)
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
            <ContextMenuItem color={colors.accent} onClick={() => setShowNewGroupInput(true)}>
              <Plus size={12} color={colors.accent} />
              <span>New group...</span>
            </ContextMenuItem>
          )}
        </>
      )}
    </motion.div>,
    popoverLayer,
  )
}
