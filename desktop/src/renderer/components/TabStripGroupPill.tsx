import React, { useState, useRef, useEffect, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { X, CaretDown, PencilSimple } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import type { TabGroupView } from '../hooks/useTabGroups'
import { checkWorktreeUncommitted, shouldUseWorktree, zoomRect } from './TabStripShared'
import { StackedStatusDots } from './TabStripStatusDot'
import { InlineRenameInput } from './TabStripInlineRenameInput'
import { PillColorPicker } from './TabStripPillColorPicker'
import { TabContextMenu } from './TabStripTabContextMenu'
import { InactiveGroupMenu } from './TabStripInactiveGroupMenu'
import { GroupPickerDropdown } from './TabStripGroupPickerDropdown'

interface GroupPillProps {
  group: TabGroupView
  isActive: boolean
  onSelect: (tabId: string) => void
}

/** A grouped collection of tabs, rendered as a single pill. Click opens the dropdown picker for multi-tab groups; single-tab groups behave like a regular tab pill. */
export function GroupPill({
  group,
  isActive,
  onSelect,
}: GroupPillProps) {
  const colors = useColors()
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  const renameTab = useSessionStore((s) => s.renameTab)
  const setTabPillColor = useSessionStore((s) => s.setTabPillColor)
  const setTabPillIcon = useSessionStore((s) => s.setTabPillIcon)
  const worktreeUncommittedMap = useSessionStore((s) => s.worktreeUncommittedMap)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [mgmtMenu, setMgmtMenu] = useState<{ x: number; y: number } | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number } | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const pillRef = useRef<HTMLDivElement>(null)

  const selectedTab = group.tabs.find((t) => t.id === group.selectedTabId) || group.tabs[0]

  useEffect(() => {
    if (tabMenu) checkWorktreeUncommitted(selectedTab)
  }, [tabMenu])

  // Close picker when any new tab is created (from +button, keyboard shortcut, or another picker)
  useEffect(() => {
    const handler = () => setPickerOpen(false)
    window.addEventListener('ion:close-group-pickers', handler)
    return () => window.removeEventListener('ion:close-group-pickers', handler)
  }, [])

  const displayTitle = selectedTab ? (selectedTab.customTitle || selectedTab.title) : ''

  // Derive aggregate waiting state: if ANY tab in the group is waiting on the user
  // Question takes priority over plan-ready across all tabs in the group
  const groupWaitingState: 'plan-ready' | 'question' | null = (() => {
    let hasPlanReady = false
    for (const t of group.tabs) {
      const tools = t.permissionDenied?.tools
      if (!tools?.length) continue
      if (tools.some((x) => x.toolName === 'AskUserQuestion')) return 'question'
      if (tools.some((x) => x.toolName === 'ExitPlanMode')) hasPlanReady = true
    }
    return hasPlanReady ? 'plan-ready' : null
  })()

  const waitingBorder = groupWaitingState === 'plan-ready'
    ? colors.tabGlowPlanReady
    : groupWaitingState === 'question'
      ? colors.tabGlowQuestion
      : null

  const handleClick = useCallback(() => {
    // Single-tab group: activate the tab directly
    if (group.tabs.length === 1) {
      onSelect(group.tabs[0].id)
      return
    }
    if (pillRef.current) {
      const rect = zoomRect(pillRef.current.getBoundingClientRect())
      setPickerAnchor({ x: rect.left, y: rect.bottom })
    }
    setPickerOpen((o) => !o)
  }, [group.tabs, onSelect])

  return (
    <>
      <div
        ref={pillRef}
        className={`group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 ${waitingBorder ? 'animate-border-pulse' : ''}`}
        style={{
          '--border-waiting': waitingBorder ?? 'transparent',
          '--border-default': isActive ? colors.tabActiveBorder : 'transparent',
          background: isActive ? colors.tabActive : 'transparent',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: waitingBorder ?? (isActive ? colors.tabActiveBorder : 'transparent'),
          borderRadius: 9999,
          padding: '4px 12px',
          fontSize: 12,
          color: isActive ? colors.textPrimary : colors.textTertiary,
          fontWeight: isActive ? 500 : 400,
        } as React.CSSProperties}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            if (!isActive || !selectedTab || selectedTab.worktree) return
            const running = selectedTab.status === 'running' || selectedTab.status === 'connecting'
            if (!running && !selectedTab.bashExecuting) {
              useSessionStore.getState().closeTab(selectedTab.id)
            }
          }
        }}
        onClick={handleClick}
        onContextMenu={(e) => {
          if (tabGroupMode === 'manual') {
            e.preventDefault()
            e.stopPropagation()
            if (isActive) {
              setTabMenu({ x: e.clientX, y: e.clientY })
            } else {
              setMgmtMenu({ x: e.clientX, y: e.clientY })
            }
          }
        }}
      >
        <span
          className="flex-shrink-0 inline-flex"
          onContextMenu={group.tabs.length === 1 ? (e) => {
            e.preventDefault()
            e.stopPropagation()
            setColorPickerAnchor({ x: e.clientX, y: e.clientY })
            setColorPickerOpen(true)
          } : undefined}
        >
          <StackedStatusDots tabs={group.tabs} />
        </span>
        <span className="flex-shrink-0 text-[10px] font-medium" style={{ color: colors.textSecondary, opacity: 0.5 }}>
          {group.label}
        </span>
        {isActive && selectedTab && (
          renamingTitle ? (
            <InlineRenameInput
              value={displayTitle}
              color={colors.textPrimary}
              fontWeight={500}
              onCommit={(newValue) => {
                setRenamingTitle(false)
                renameTab(selectedTab.id, newValue || null)
              }}
              onCancel={() => setRenamingTitle(false)}
            />
          ) : (
            <span className="truncate max-w-[100px]">
              {displayTitle}
            </span>
          )
        )}
        {isActive && (
          <button
            onClick={(e) => { e.stopPropagation(); setRenamingTitle(true) }}
            className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center"
            style={{ opacity: 0.5, color: colors.textSecondary, background: 'none', border: 'none', cursor: 'pointer' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
          >
            <PencilSimple size={10} />
          </button>
        )}
        <span className="text-[10px] flex-shrink-0" style={{ color: colors.textTertiary }}>
          {group.tabs.length}
        </span>
        {group.tabs.length > 1 && (
          <CaretDown
            size={10}
            className="flex-shrink-0 transition-transform"
            style={{
              color: colors.textTertiary,
              transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        )}
        {group.tabs.length === 1 && (() => {
          const tab = group.tabs[0]
          const isRunning = tab.status === 'running' || tab.status === 'connecting'
          if (isRunning || tab.bashExecuting) return null
          if (confirmingClose) {
            return (
              <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setConfirmingClose(false)}
                  className="px-1 rounded"
                  style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  No
                </button>
                <button
                  onClick={() => { useSessionStore.getState().closeTab(tab.id); setConfirmingClose(false) }}
                  className="px-1 rounded"
                  style={{ color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Yes
                </button>
              </div>
            )
          }
          return (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmingClose(true) }}
              className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center"
              style={{ opacity: 0.5, color: colors.textSecondary, background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
            >
              <X size={10} />
            </button>
          )
        })()}
      </div>

      <AnimatePresence>
        {pickerOpen && (
          <GroupPickerDropdown
            key="group-picker"
            group={group}
            anchor={pickerAnchor}
            onSelectTab={(tabId) => { onSelect(tabId) }}
            onCloseTab={(tabId) => useSessionStore.getState().closeTab(tabId)}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {mgmtMenu && (
          <InactiveGroupMenu
            key="inactive-group"
            anchor={mgmtMenu}
            group={group}
            onClose={() => setMgmtMenu(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tabMenu && selectedTab && (() => {
          const tab = selectedTab
          return (
            <TabContextMenu
              key="group-tab-ctx"
              anchor={tabMenu}
              tab={tab}
              onRename={() => { setTabMenu(null); setRenamingTitle(true) }}
              onForkTab={tab.conversationId ? () => { useSessionStore.getState().forkTab(tab.id) } : undefined}
              onNewTabInDir={() => useSessionStore.getState().createTabInDirectory(tab.workingDirectory, shouldUseWorktree(false))}
              onFinishWork={() => { if (tab.worktree) useSessionStore.getState().finishWorktreeTab(tab.id) }}
              finishWorkDisabled={tab.worktree ? (worktreeUncommittedMap.has(tab.id) ? worktreeUncommittedMap.get(tab.id)! : 'checking') : undefined}
              onClose={() => setTabMenu(null)}
              groupTabs={group.tabs}
            />
          )
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {colorPickerOpen && group.tabs.length === 1 && (() => {
          const tab = group.tabs[0]
          return (
            <PillColorPicker
              key="group-pill-color-picker"
              anchor={colorPickerAnchor}
              currentColor={tab.pillColor}
              onSelect={(color) => setTabPillColor(tab.id, color)}
              currentIcon={tab.pillIcon}
              onSelectIcon={(icon) => setTabPillIcon(tab.id, icon)}
              onClose={() => setColorPickerOpen(false)}
            />
          )
        })()}
      </AnimatePresence>
    </>
  )
}
