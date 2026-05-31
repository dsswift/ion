import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  Plus, GitFork, FolderOpen, GitBranch, CheckCircle, CaretDown, Rows,
  PencilSimple, ArrowRight, ArrowsInSimple, PushPin, PushPinSlash,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore, getEffectiveTabGroups } from '../preferences'
import type { TabState } from '../../shared/types'
import { zoomRect, zoomViewport, useAnchoredPopoverPosition } from './TabStripShared'
import { MoveToGroupSubmenu } from './TabStripMoveToGroupSubmenu'
import { ConfirmDialog } from './git/ConfirmDialog'

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
  const toggleTabGroupPin = useSessionStore((s) => s.toggleTabGroupPin)
  const [moveSubmenu, setMoveSubmenu] = useState<{ x: number; y: number } | null>(null)
  // Bounding rect of the row that triggered the submenu, captured at
  // open time. Passed to `MoveToGroupSubmenu` so its positioning hook
  // can flip the submenu to the left of the parent row when the right
  // side of the viewport would clip it. We keep one rect per submenu
  // (move / movePin / moveAll) because each is anchored to a
  // different row.
  const [moveParentRect, setMoveParentRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const moveItemRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  // Parallel state for the "Move to group and pin" submenu. We keep it
  // separate from `moveSubmenu` so the hover/click positioning logic for
  // each row is independent — both rows live in the same context menu and
  // either can be opened without disturbing the other.
  const [movePinSubmenu, setMovePinSubmenu] = useState<{ x: number; y: number } | null>(null)
  const [movePinParentRect, setMovePinParentRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const movePinItemRef = useRef<HTMLButtonElement>(null)
  const movePinSubmenuRef = useRef<HTMLDivElement>(null)
  const [moveAllSubmenu, setMoveAllSubmenu] = useState<{ x: number; y: number } | null>(null)
  const [moveAllParentRect, setMoveAllParentRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const moveAllItemRef = useRef<HTMLButtonElement>(null)
  const moveAllSubmenuRef = useRef<HTMLDivElement>(null)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const newGroupInputRef = useRef<HTMLInputElement>(null)
  const [pendingMoveAll, setPendingMoveAll] = useState<{ groupId: string; label: string } | null>(null)

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
          (!movePinSubmenuRef.current || !movePinSubmenuRef.current.contains(e.target as Node)) &&
          (!moveAllSubmenuRef.current || !moveAllSubmenuRef.current.contains(e.target as Node))) { setMoveSubmenu(null); setMovePinSubmenu(null); setMoveAllSubmenu(null); onClose() }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoveSubmenu(null); setMovePinSubmenu(null); setMoveAllSubmenu(null); onClose() }
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Position the outer menu so it never falls off-screen. The hook
  // measures the menu after mount and flips it upward when the
  // anchor is near the bottom edge. Items that conditionally render
  // (worktree-only "Finish work", manual-mode rows, "Move all to
  // group", git-detection "Convert to worktree", and the inline
  // "showNewGroupInput") all change the rendered height — include
  // every one in `deps` so the hook re-measures on each transition.
  const pos = useAnchoredPopoverPosition(anchor, {
    prefer: 'below',
    deps: [
      !!onRename,
      !!onForkTab,
      !!tab.workingDirectory,
      !!tab.worktree,
      isGitRepo,
      tabGroupMode,
      showMoveAll,
      // Submenu state toggles aren't expected to change outer
      // height (submenus portal out), but keep them in deps so the
      // hook re-checks after a manual viewport change near the
      // moment of submenu interaction.
      moveSubmenu,
      movePinSubmenu,
      moveAllSubmenu,
    ],
  })
  const vp = zoomViewport()

  if (!popoverLayer) return null

  const menuItemStyle = {
    fontSize: 12,
    color: colors.textPrimary,
    background: 'transparent' as string,
    border: 'none' as const,
    cursor: 'pointer' as const,
  }

  return createPortal(
    <>
      <motion.div
        ref={(node) => { (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
        data-ion-ui
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.12 }}
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
            onClick={() => { toggleTabGroupPin(tab.id); onClose() }}
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={menuItemStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            {tab.groupPinned
              ? <PushPinSlash size={14} color={colors.textSecondary} />
              : <PushPin size={14} color={colors.textSecondary} />
            }
            <span>{tab.groupPinned ? 'Unpin from group' : 'Pin to group'}</span>
          </button>
          <button
            ref={moveItemRef}
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={menuItemStyle}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = colors.tabActive
              setMoveAllSubmenu(null)
              setMoveAllParentRect(null)
              setMovePinSubmenu(null)
              setMovePinParentRect(null)
              if (moveItemRef.current) {
                const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
                setMoveSubmenu({ x: rect.right, y: rect.top })
                setMoveParentRect({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              if (moveItemRef.current) {
                const rect = zoomRect(moveItemRef.current.getBoundingClientRect())
                setMoveSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
                setMoveParentRect((prev) => prev ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
          >
            <Rows size={14} color={colors.textSecondary} />
            <span>Move to group</span>
            <CaretDown size={10} color={colors.textTertiary} style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} />
          </button>
          {/*
            "Move to group and pin" — combined action. Identical layout to the
            "Move to group" row above but uses a distinct submenu (different
            anchor/state) so the pin-aware target picker can render with its
            own header and click handler (see MoveToGroupSubmenu's `pinAfter`).
            Shown alongside the plain "Move" so the user can pick either
            semantic without having to perform two separate steps.
          */}
          <button
            ref={movePinItemRef}
            className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
            style={menuItemStyle}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = colors.tabActive
              setMoveAllSubmenu(null)
              setMoveAllParentRect(null)
              setMoveSubmenu(null)
              setMoveParentRect(null)
              if (movePinItemRef.current) {
                const rect = zoomRect(movePinItemRef.current.getBoundingClientRect())
                setMovePinSubmenu({ x: rect.right, y: rect.top })
                setMovePinParentRect({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            onClick={() => {
              if (movePinItemRef.current) {
                const rect = zoomRect(movePinItemRef.current.getBoundingClientRect())
                setMovePinSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
                setMovePinParentRect((prev) => prev ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }
            }}
          >
            <PushPin size={14} color={colors.textSecondary} />
            <span>Move to group and pin</span>
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
            setMoveParentRect(null)
            setMovePinSubmenu(null)
            setMovePinParentRect(null)
            if (moveAllItemRef.current) {
              const rect = zoomRect(moveAllItemRef.current.getBoundingClientRect())
              setMoveAllSubmenu({ x: rect.right, y: rect.top })
              setMoveAllParentRect({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
            }
          }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          onClick={() => {
            if (moveAllItemRef.current) {
              const rect = zoomRect(moveAllItemRef.current.getBoundingClientRect())
              setMoveAllSubmenu((prev) => prev ? null : { x: rect.right, y: rect.top })
              setMoveAllParentRect((prev) => prev ? null : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
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
          parentRect={moveParentRect ?? undefined}
          onClose={() => { setMoveSubmenu(null); setMoveParentRect(null); onClose() }}
        />
      )}
      {/*
        Pin-aware variant: same component, same target list, but
        `pinAfter` flips the title and the click handler to use
        moveTabToGroupAndPin so the destination tab ends up with
        groupPinned=true in the same store update.
      */}
      {movePinSubmenu && (
        <MoveToGroupSubmenu
          anchor={movePinSubmenu}
          tabId={tab.id}
          currentGroupId={tab.groupId || ''}
          containerRef={movePinSubmenuRef}
          parentRect={movePinParentRect ?? undefined}
          pinAfter
          onClose={() => { setMovePinSubmenu(null); setMovePinParentRect(null); onClose() }}
        />
      )}
      {moveAllSubmenu && showMoveAll && popoverLayer && (
        <MoveAllToGroupInlineSubmenu
          anchor={moveAllSubmenu}
          parentRect={moveAllParentRect ?? undefined}
          currentGroupId={tab.groupId || ''}
          tabGroups={tabGroups}
          submenuRef={moveAllSubmenuRef}
          popoverLayer={popoverLayer}
          colors={colors}
          showNewGroupInput={showNewGroupInput}
          setShowNewGroupInput={setShowNewGroupInput}
          newGroupInputRef={newGroupInputRef}
          newGroupName={newGroupName}
          setNewGroupName={setNewGroupName}
          onPickTarget={(groupId, label) => {
            console.log('[TabContextMenu] move-all confirmation requested', { tabCount: groupTabs?.length ?? 0, targetGroupId: groupId, targetLabel: label })
            setMoveAllSubmenu(null)
            setMoveAllParentRect(null)
            setPendingMoveAll({ groupId, label })
          }}
        />
      )}
    </motion.div>
    {pendingMoveAll && groupTabs && (
      <ConfirmDialog
        title="Move all tabs?"
        message={`Move all ${groupTabs.length} tab${groupTabs.length !== 1 ? 's' : ''} to "${pendingMoveAll.label}"? This will move every tab in the current group.`}
        confirmLabel="Move all"
        cancelLabel="Cancel"
        danger={false}
        onConfirm={() => {
          console.log('[TabContextMenu] move-all confirmed', { tabCount: groupTabs.length, targetGroupId: pendingMoveAll.groupId, targetLabel: pendingMoveAll.label })
          for (const t of groupTabs) moveTabToGroup(t.id, pendingMoveAll.groupId)
          setPendingMoveAll(null)
          onClose()
        }}
        onCancel={() => {
          console.log('[TabContextMenu] move-all cancelled', { tabCount: groupTabs.length, targetGroupId: pendingMoveAll.groupId, targetLabel: pendingMoveAll.label })
          setPendingMoveAll(null)
          onClose()
        }}
      />
    )}
    </>,
    popoverLayer,
  )
}

interface MoveAllToGroupInlineSubmenuProps {
  anchor: { x: number; y: number }
  parentRect?: { left: number; right: number; top: number; bottom: number }
  currentGroupId: string
  tabGroups: ReturnType<typeof usePreferencesStore.getState>['tabGroups']
  submenuRef: React.RefObject<HTMLDivElement | null>
  popoverLayer: HTMLDivElement
  colors: ReturnType<typeof useColors>
  showNewGroupInput: boolean
  setShowNewGroupInput: (v: boolean) => void
  newGroupInputRef: React.RefObject<HTMLInputElement | null>
  newGroupName: string
  setNewGroupName: (v: string) => void
  onPickTarget: (groupId: string, label: string) => void
}

/**
 * Inline "Move all to group" submenu — extracted out of TabContextMenu
 * so it can call `useAnchoredPopoverPosition` (hooks can't run inside
 * an inline IIFE conditional render). Shares the same visual design
 * as `MoveToGroupSubmenu` but operates on a fixed group-target list
 * (no `pinAfter` semantics) and reports the chosen target via
 * `onPickTarget` instead of dispatching the move directly — the
 * caller routes it through a confirmation dialog.
 *
 * Positioning is delegated to the shared hook with `prefer:
 * 'rightOf'` (same as MoveToGroupSubmenu) so the submenu flips left
 * when the viewport is narrow, and flips up when the parent menu
 * sits near the bottom edge of the window. `showNewGroupInput` is in
 * the re-measure deps so expanding the inline input re-positions the
 * menu and the input row stays visible.
 */
function MoveAllToGroupInlineSubmenu({
  anchor,
  parentRect,
  currentGroupId,
  tabGroups,
  submenuRef,
  popoverLayer,
  colors,
  showNewGroupInput,
  setShowNewGroupInput,
  newGroupInputRef,
  newGroupName,
  setNewGroupName,
  onPickTarget,
}: MoveAllToGroupInlineSubmenuProps) {
  const effectiveGroups = getEffectiveTabGroups(tabGroups)
  const targets = effectiveGroups
    .filter((g) => g.id !== currentGroupId)
    .map((g) => ({ id: g.id, label: g.label }))
  const vp = zoomViewport()
  const pos = useAnchoredPopoverPosition(anchor, {
    prefer: 'rightOf',
    parentRect,
    deps: [showNewGroupInput, targets.length],
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
        <button
          key={t.id}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          onClick={() => onPickTarget(t.id, t.label)}
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
}
