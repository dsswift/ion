import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import type { TabGroupView } from '../hooks/useTabGroups'
import { checkWorktreeUncommitted } from './TabStripShared'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { zoomViewport } from '../viewport-zoom'
import { PillColorPicker } from './TabStripPillColorPicker'
import { TabContextMenu } from './TabStripTabContextMenu'
import { useRenameTabWorktree } from '../hooks/useRenameTabWorktree'
import { DropdownTabRow } from './TabStripDropdownTabRow'
import { rError } from '../rendererLogger'

interface GroupPickerDropdownProps {
  group: TabGroupView
  anchor: { x: number; y: number }
  /** Coordinates from the caller's raw pointer or an already-normalized pill rect. */
  anchorSpace?: 'viewport' | 'css'
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onClose: () => void
}

/** Dropdown shown when a multi-tab group pill is clicked. Renders a reorderable list of the group's tabs with sub-popovers (color picker, context menu). */
export function GroupPickerDropdown({
  group,
  anchor,
  anchorSpace = 'viewport',
  onSelectTab,
  onCloseTab,
  onClose,
}: GroupPickerDropdownProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const renameTab = useSessionStore((s) => s.renameTab)
  const setTabPillColor = useSessionStore((s) => s.setTabPillColor)
  const setTabPillIcon = useSessionStore((s) => s.setTabPillIcon)
  const worktreeUncommittedMap = useSessionStore((s) => s.worktreeUncommittedMap)

  // Sub-interaction state
  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirMenuTabId, setDirMenuTabId] = useState<string | null>(null)
  const renameWithWorktree = useRenameTabWorktree()
  const [dirMenuAnchor, setDirMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [localTabs, setLocalTabs] = useState(group.tabs)

  useEffect(() => {
    if (dirMenuTabId) checkWorktreeUncommitted(group.tabs.find((t) => t.id === dirMenuTabId))
  }, [dirMenuTabId, group.tabs])

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
          if (target.closest?.('[data-ion-ui]')) return // click inside a child popover — let it handle
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

  // Measured placement. This used to clamp against hardcoded 300x280 numbers
  // that had to be kept in sync by hand with the maxHeight/minWidth below —
  // a guess, and wrong for any dropdown that renders shorter than its cap.
  const pos = useAnchoredPopover(anchor, { anchorSpace, deps: [localTabs.length, editingTabId] })
  const vp = zoomViewport()

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={(node) => { (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
      data-ion-ui
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 10,
        padding: 4,
        zIndex: 10000,
        minWidth: 220,
        maxWidth: 340,
        maxHeight: Math.min(300, vp.height - 16),
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
    >
      <Reorder.Group
        as="div"
        axis="y"
        values={localTabs}
        onReorder={(reordered) => {
          setLocalTabs(reordered)
          // reorderTabs takes an ORDER OF IDS (see tab-slice.ts): send this
          // group's ids in their new relative order and let the owner apply
          // that ordering to its own authoritative tabs, preserving every
          // tab outside the group untouched. Building a full replacement
          // array from `useSessionStore.getState().tabs` here would forward
          // a full-array snapshot that could be stale in the Studio mirror.
          useSessionStore.getState().reorderTabs(reordered.map((t) => t.id))
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
            editingTabId={editingTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onClose={onClose}
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
              currentIcon={pickerTab.pillIcon}
              onSelectIcon={(icon) => { setTabPillIcon(colorPickerTabId, icon); setColorPickerTabId(null) }}
              onClose={() => setColorPickerTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

      {/* Sub-popovers: tab context menu */}
      <AnimatePresence>
        {dirMenuTabId && (() => {
          const menuTab = group.tabs.find((t) => t.id === dirMenuTabId)
          if (!menuTab) return null
          return (
            <TabContextMenu
              key="dropdown-tab-menu"
              anchor={dirMenuAnchor}
              tab={menuTab}
              onRename={() => { setDirMenuTabId(null); setEditingTabId(menuTab.id) }}
              onRenameWithWorktree={() => { setDirMenuTabId(null); renameWithWorktree.requestRename(menuTab) }}
              onForkTab={menuTab.conversationId ? () => {
                void useSessionStore.getState().forkTab(menuTab.id).catch((err) => rError('tabs', 'fork tab failed', { error: String(err) }))
                setDirMenuTabId(null)
              } : undefined}
              onNewTabInDir={() => {
                window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
                window.dispatchEvent(new CustomEvent('ion:open-new-conversation-picker'))
              }}
              onFinishWork={() => {
                void useSessionStore.getState().finishWorktreeTab(menuTab.id).catch((err) => rError('tabs', 'finish worktree failed', { error: String(err) }))
                setDirMenuTabId(null)
              }}
              finishWorkDisabled={menuTab.worktree ? (worktreeUncommittedMap.has(menuTab.id) ? worktreeUncommittedMap.get(menuTab.id)! : 'checking') : undefined}
              onClose={() => setDirMenuTabId(null)}
              groupTabs={group.tabs}
            />
          )
        })()}
      </AnimatePresence>

      {renameWithWorktree.dialog}

    </motion.div>,
    popoverLayer,
  )
}
