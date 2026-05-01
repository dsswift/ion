import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import type { TabGroupView } from '../hooks/useTabGroups'
import { checkWorktreeUncommitted, shouldUseWorktree, zoomViewport } from './TabStripShared'
import { PillColorPicker } from './TabStripPillColorPicker'
import { TabContextMenu } from './TabStripTabContextMenu'
import { DropdownTabRow } from './TabStripDropdownTabRow'

interface GroupPickerDropdownProps {
  group: TabGroupView
  anchor: { x: number; y: number }
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onClose: () => void
}

/** Dropdown shown when a multi-tab group pill is clicked. Renders a reorderable list of the group's tabs with sub-popovers (color picker, context menu). */
export function GroupPickerDropdown({
  group,
  anchor,
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
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)
  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirMenuTabId, setDirMenuTabId] = useState<string | null>(null)
  const [dirMenuAnchor, setDirMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [localTabs, setLocalTabs] = useState(group.tabs)

  useEffect(() => {
    if (dirMenuTabId) checkWorktreeUncommitted(group.tabs.find((t) => t.id === dirMenuTabId))
  }, [dirMenuTabId])

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

  const vp = zoomViewport()
  const top = Math.min(anchor.y + 8, vp.height - 300)
  const left = Math.min(anchor.x, vp.width - 280)

  return createPortal(
    <motion.div
      ref={ref}
      data-ion-ui
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
              onForkTab={menuTab.conversationId ? () => {
                useSessionStore.getState().forkTab(menuTab.id)
                setDirMenuTabId(null)
              } : undefined}
              onNewTabInDir={() => {
                window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
                useSessionStore.getState().createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))
              }}
              onFinishWork={() => {
                useSessionStore.getState().finishWorktreeTab(menuTab.id)
                setDirMenuTabId(null)
              }}
              finishWorkDisabled={menuTab.worktree ? (worktreeUncommittedMap.has(menuTab.id) ? worktreeUncommittedMap.get(menuTab.id)! : 'checking') : undefined}
              onClose={() => setDirMenuTabId(null)}
              groupTabs={group.tabs}
            />
          )
        })()}
      </AnimatePresence>

    </motion.div>,
    popoverLayer,
  )
}
