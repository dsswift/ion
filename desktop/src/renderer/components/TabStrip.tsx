import React, { useState, useRef, useEffect, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  Terminal, CaretLeft, CaretRight, ArrowsInSimple, ArrowsOutSimple, Lightning, ChatCircle,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { BranchPickerDialog } from './BranchPickerDialog'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { EngineProfilePicker } from './EngineProfilePicker'
import { useTabGroups } from '../hooks/useTabGroups'
import type { TabState } from '../../shared/types'
import { useManualReorder } from '../hooks/useManualReorder'
import { checkWorktreeUncommitted, shouldUseWorktree, zoomRect } from './TabStripShared'
import { PillColorPicker } from './TabStripPillColorPicker'
import { DirContextMenu } from './TabStripDirContextMenu'
import { TabContextMenu } from './TabStripTabContextMenu'
import { DirectoryPicker } from './TabStripDirectoryPicker'
import { GroupPill } from './TabStripGroupPill'
import { TabPill } from './TabStripTabPill'

export function TabStrip() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const selectTab = useSessionStore((s) => s.selectTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const reorderTabs = useSessionStore((s) => s.reorderTabs)
  const renameTab = useSessionStore((s) => s.renameTab)
  const setTabPillColor = useSessionStore((s) => s.setTabPillColor)
  const setTabPillIcon = useSessionStore((s) => s.setTabPillIcon)
  const createTabInDirectory = useSessionStore((s) => s.createTabInDirectory)
  const toggleTerminal = useSessionStore((s) => s.toggleTerminal)
  const createTerminalTab = useSessionStore((s) => s.createTerminalTab)
  const createEngineTab = useSessionStore((s) => s.createEngineTab)
  const terminalOpenTabIds = useSessionStore((s) => s.terminalOpenTabIds)
  const colors = useColors()
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const toggleExpanded = useSessionStore((s) => s.toggleExpanded)
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const worktreeUncommittedMap = useSessionStore((s) => s.worktreeUncommittedMap)
  const { mode: groupMode, groups, ungrouped } = useTabGroups()

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)
  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirMenuTabId, setDirMenuTabId] = useState<string | null>(null)
  const [dirMenuAnchor, setDirMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirPickerState, setDirPickerState] = useState<{ anchor: { x: number; y: number; bottom: number }; mode: 'conversation' | 'terminal' | 'engine' } | null>(null)
  const [enginePickerState, setEnginePickerState] = useState<{ anchor: { x: number; y: number; bottom: number }; dir: string } | null>(null)
  const [tabMenuId, setTabMenuId] = useState<string | null>(null)
  const [tabMenuAnchor, setTabMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const plusButtonRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const groupHeaderRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Manual drag-to-reorder for flat tab mode
  const flatReorder = useManualReorder({
    items: tabs,
    keyFn: (t) => t.id,
    itemRefs: tabRefs,
    onReorder: reorderTabs,
  })

  // Manual drag-to-reorder for group headers
  const groupIds = groups.map((g) => g.groupId)
  const groupReorder = useManualReorder({
    items: groupIds,
    keyFn: (id) => id,
    itemRefs: groupHeaderRefs,
    onReorder: (reorderedIds) => {
      if (groupMode === 'manual') {
        const allGroups = usePreferencesStore.getState().tabGroups
        const reorderedTabGroups = reorderedIds.map((id) => {
          const stored = allGroups.find((sg) => sg.id === id)
          const view = groups.find((g) => g.groupId === id)
          return stored || { id, label: view?.label || id, isDefault: view?.isDefault || false, order: 0, collapsed: view?.collapsed || false }
        })
        // Preserve empty groups that weren't visible in the strip
        const reorderedIdSet = new Set(reorderedIds)
        const missingGroups = allGroups.filter((g) => !reorderedIdSet.has(g.id))
        usePreferencesStore.getState().reorderTabGroups([...reorderedTabGroups, ...missingGroups])
      } else if (groupMode === 'auto') {
        const dirs = reorderedIds.map((id) => id.replace('auto-', ''))
        usePreferencesStore.getState().setAutoGroupOrder(dirs)
      }
    },
  })

  // Manual drag-to-reorder for ungrouped tabs
  const ungroupedReorder = useManualReorder({
    items: ungrouped,
    keyFn: (t) => t.id,
    itemRefs: tabRefs,
    onReorder: (reordered) => {
      const ungroupedOrder = new Map(reordered.map((t, i) => [t.id, i]))
      const result = [...tabs].sort((a, b) => {
        const aIdx = ungroupedOrder.get(a.id)
        const bIdx = ungroupedOrder.get(b.id)
        if (aIdx != null && bIdx != null) return aIdx - bIdx
        return 0
      })
      reorderTabs(result)
    },
  })

  useEffect(() => {
    const id = dirMenuTabId || tabMenuId
    if (id) checkWorktreeUncommitted(tabs.find((t) => t.id === id))
  }, [dirMenuTabId, tabMenuId])

  // Scroll the confirming-close tab into view after it expands
  useEffect(() => {
    if (!confirmingCloseId) return
    requestAnimationFrame(() => {
      const el = tabRefs.current.get(confirmingCloseId)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
  }, [confirmingCloseId])

  // Auto-scroll the active tab into view when it changes
  useEffect(() => {
    if (!activeTabId) return
    requestAnimationFrame(() => {
      const el = tabRefs.current.get(activeTabId)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
  }, [activeTabId])

  // Track whether the tab strip can scroll left/right
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollIndicators = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateScrollIndicators()
    el.addEventListener('scroll', updateScrollIndicators, { passive: true })
    const ro = new ResizeObserver(updateScrollIndicators)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollIndicators)
      ro.disconnect()
    }
  }, [updateScrollIndicators])

  // Also update scroll indicators when tabs change
  useEffect(() => {
    requestAnimationFrame(updateScrollIndicators)
  }, [tabs.length, updateScrollIndicators])

  const scrollBy = useCallback((amount: number) => {
    scrollRef.current?.scrollBy({ left: amount, behavior: 'smooth' })
  }, [])

  // Convert vertical wheel to horizontal scroll (also allow native horizontal scroll)
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!scrollRef.current) return
    const delta = e.deltaX || e.deltaY
    if (delta === 0) return
    e.preventDefault()
    scrollRef.current.scrollLeft += delta
  }, [])

  if (!tabsReady) {
    return <div data-ion-ui className="flex items-center" style={{ padding: '8px 0', height: 40 }} />
  }

  const renderTabPill = (tab: TabState, reorder: { onItemPointerDown: (key: string, e: React.PointerEvent) => void; isDraggingRef: React.RefObject<boolean> }) => (
    <TabPill
      key={tab.id}
      tab={tab}
      isActive={tab.id === activeTabId}
      isEditing={editingTabId === tab.id}
      isConfirmingClose={confirmingCloseId === tab.id}
      onSelect={() => selectTab(tab.id)}
      onClose={() => closeTab(tab.id)}
      onStartEdit={() => setEditingTabId(tab.id)}
      onStopEdit={() => setEditingTabId(null)}
      onRename={(newValue) => renameTab(tab.id, newValue)}
      onConfirmClose={() => setConfirmingCloseId(tab.id)}
      onCancelClose={() => setConfirmingCloseId(null)}
      onSetPillColor={(color) => setTabPillColor(tab.id, color)}
      colorPickerTabId={colorPickerTabId}
      onOpenColorPicker={(tabId, anchor) => { setColorPickerTabId(tabId); setColorPickerAnchor(anchor) }}
      onCloseColorPicker={() => setColorPickerTabId(null)}
      onOpenDirMenu={(tabId, anchor) => { setDirMenuTabId(tabId); setDirMenuAnchor(anchor) }}
      onCreateTabInDir={(dir) => createTabInDirectory(dir, shouldUseWorktree(false))}
      dirMenuTabId={dirMenuTabId}
      onOpenTabMenu={(tabId, anchor) => { setTabMenuId(tabId); setTabMenuAnchor(anchor) }}
      tabRefs={tabRefs}
      onDragPointerDown={reorder.onItemPointerDown}
      isDraggingRef={reorder.isDraggingRef}
    />
  )

  return (
    <div
      data-ion-ui
      className="flex items-center"
      style={{ padding: '8px 0' }}
    >
      {/* Minimize / maximize toggle */}
      <button
        onClick={toggleExpanded}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ml-1"
        style={{ color: isExpanded ? colors.textTertiary : colors.accent }}
        title={isExpanded ? 'Minimize (Cmd+J)' : 'Maximize (Cmd+K)'}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = colors.textPrimary }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = isExpanded ? colors.textTertiary : colors.accent }}
      >
        {isExpanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
      </button>

      {/* Scrollable tabs area — clipped by master card edge */}
      <div className="relative min-w-0 flex-1">
        {canScrollLeft && (
          <button
            onClick={() => scrollBy(-150)}
            className="absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center w-5 transition-opacity"
            style={{ color: colors.textTertiary, background: `linear-gradient(to right, ${colors.containerBg}, transparent)` }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = colors.textPrimary }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = colors.textTertiary }}
          >
            <CaretLeft size={12} weight="bold" />
          </button>
        )}
        {canScrollRight && (
          <button
            onClick={() => scrollBy(150)}
            className="absolute right-0 top-0 bottom-0 z-10 flex items-center justify-center w-5 transition-opacity"
            style={{ color: colors.textTertiary, background: `linear-gradient(to left, ${colors.containerBg}, transparent)` }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = colors.textPrimary }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = colors.textTertiary }}
          >
            <CaretRight size={12} weight="bold" />
          </button>
        )}
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
          {groupMode === 'off' ? (
            // Original flat tab rendering
            <div className="flex items-center gap-1 w-max">
              {tabs.map((tab) => renderTabPill(tab, flatReorder))}
            </div>
          ) : (
            // Grouped rendering: group headers + ungrouped tabs
            <div className="flex items-center gap-1 w-max">
              {groups.map((group) => {
                const isGroupActive = group.tabs.some((t) => t.id === activeTabId)
                return (
                  <div
                    key={group.groupId}
                    ref={(el: HTMLDivElement | null) => {
                      if (el) groupHeaderRefs.current.set(group.groupId, el)
                      else groupHeaderRefs.current.delete(group.groupId)
                    }}
                    onPointerDown={(e) => groupReorder.onItemPointerDown(group.groupId, e)}
                    style={{ flexShrink: 0 }}
                  >
                    <GroupPill
                      group={group}
                      isActive={isGroupActive}
                      onSelect={(tabId) => selectTab(tabId)}
                    />
                  </div>
                )
              })}
              {ungrouped.length > 0 && (
                <div className="flex items-center gap-1">
                  {ungrouped.map((tab) => renderTabPill(tab, ungroupedReorder))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {colorPickerTabId && (() => {
          const pickerTab = tabs.find((t) => t.id === colorPickerTabId)
          if (!pickerTab) return null
          return (
            <PillColorPicker
              key="pill-color-picker"
              anchor={colorPickerAnchor}
              currentColor={pickerTab.pillColor}
              onSelect={(color) => setTabPillColor(colorPickerTabId, color)}
              currentIcon={pickerTab.pillIcon}
              onSelectIcon={(icon) => setTabPillIcon(colorPickerTabId, icon)}
              onClose={() => setColorPickerTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {dirMenuTabId && (() => {
          const menuTab = tabs.find((t) => t.id === dirMenuTabId)
          if (!menuTab?.workingDirectory) return null
          const dirName = menuTab.workingDirectory.split('/').pop() || menuTab.workingDirectory
          return (
            <DirContextMenu
              key="dir-context-menu"
              anchor={dirMenuAnchor}
              dirName={dirName}
              tabId={menuTab.id}
              tabGroupId={menuTab.groupId || undefined}
              onCreateTab={() => createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))}
              onForkTab={menuTab.conversationId ? () => { useSessionStore.getState().forkTab(menuTab.id) } : undefined}
              onFinishWork={menuTab.worktree ? () => { useSessionStore.getState().finishWorktreeTab(menuTab.id) } : undefined}
              finishWorkDisabled={menuTab.worktree ? (worktreeUncommittedMap.has(menuTab.id) ? worktreeUncommittedMap.get(menuTab.id)! : 'checking') : undefined}
              onClose={() => setDirMenuTabId(null)}
            />
          )
        })()}
      </AnimatePresence>

      <AnimatePresence>
        {dirPickerState && (
          <DirectoryPicker
            key="dir-picker"
            anchor={dirPickerState.anchor}
            onSelectDir={(dir) => {
              usePreferencesStore.getState().addRecentBaseDirectory(dir)
              usePreferencesStore.getState().incrementDirectoryUsage(dir)
              switch (dirPickerState.mode) {
                case 'conversation': createTabInDirectory(dir, shouldUseWorktree(false)); break
                case 'terminal': createTerminalTab(dir); break
                case 'engine': {
                  const profiles = usePreferencesStore.getState().engineProfiles
                  if (profiles.length === 0) {
                    window.dispatchEvent(new CustomEvent('ion:open-settings'))
                  } else if (profiles.length === 1) {
                    createEngineTab(dir, profiles[0].id)
                  } else {
                    setEnginePickerState({ anchor: dirPickerState!.anchor, dir })
                  }
                  break
                }
              }
            }}
            onClose={() => setDirPickerState(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {enginePickerState && (
          <EngineProfilePicker
            key="engine-profile-picker"
            anchor={enginePickerState.anchor}
            onSelect={(profileId) => {
              createEngineTab(enginePickerState.dir, profileId)
              setEnginePickerState(null)
            }}
            onOpenSettings={() => {
              window.dispatchEvent(new CustomEvent('ion:open-settings'))
              setEnginePickerState(null)
            }}
            onClose={() => setEnginePickerState(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tabMenuId && (() => {
          const menuTab = tabs.find((t) => t.id === tabMenuId)
          if (!menuTab) return null
          return (
            <TabContextMenu
              key="tab-context-menu"
              anchor={tabMenuAnchor}
              tab={menuTab}
              onRename={() => { setTabMenuId(null); setEditingTabId(menuTab.id) }}
              onForkTab={menuTab.conversationId ? () => { useSessionStore.getState().forkTab(menuTab.id) } : undefined}
              onNewTabInDir={() => {
                if (menuTab.workingDirectory) createTabInDirectory(menuTab.workingDirectory, shouldUseWorktree(false))
              }}
              onFinishWork={() => {
                useSessionStore.getState().finishWorktreeTab(menuTab.id)
              }}
              finishWorkDisabled={menuTab.worktree ? (worktreeUncommittedMap.has(menuTab.id) ? worktreeUncommittedMap.get(menuTab.id)! : 'checking') : undefined}
              onClose={() => setTabMenuId(null)}
            />
          )
        })()}
      </AnimatePresence>

      {(() => {
        const pendingTab = tabs.find((t) => t.pendingWorktreeSetup)
        if (!pendingTab) return null
        return (
          <BranchPickerDialog
            repoPath={pendingTab.workingDirectory}
            onSelect={(branch, setAsDefault) => {
              useSessionStore.getState().setupWorktree(pendingTab.id, branch, setAsDefault)
            }}
            onCancel={() => {
              useSessionStore.getState().cancelWorktreeSetup(pendingTab.id)
            }}
          />
        )
      })()}

      {/* Pinned action buttons — always visible on the right */}
      <div className="flex items-center gap-0.5 flex-shrink-0 ml-1 pr-2">
        <button
          ref={plusButtonRef}
          onClick={(e) => {
            window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
            const rect = zoomRect((e.currentTarget as HTMLElement).getBoundingClientRect())
            setDirPickerState({ anchor: { x: rect.left, y: rect.top, bottom: rect.bottom }, mode: 'conversation' })
          }}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="New conversation tab"
        >
          <ChatCircle size={14} />
        </button>

        <button
          onClick={(e) => {
            if (e.altKey) {
              toggleTerminal(activeTabId)
            } else {
              const rect = zoomRect((e.currentTarget as HTMLElement).getBoundingClientRect())
              setDirPickerState({ anchor: { x: rect.left, y: rect.top, bottom: rect.bottom }, mode: 'terminal' })
            }
          }}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: terminalOpenTabIds.has(activeTabId) ? colors.accent : colors.textTertiary }}
          title="New terminal tab (Alt+click: toggle panel)"
        >
          <Terminal size={14} />
        </button>

        <button
          onClick={(e) => {
            const rect = zoomRect((e.currentTarget as HTMLElement).getBoundingClientRect())
            setDirPickerState({ anchor: { x: rect.left, y: rect.top, bottom: rect.bottom }, mode: 'engine' })
          }}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="New engine tab"
        >
          <Lightning size={14} />
        </button>

        <HistoryPicker />

        <SettingsPopover />
      </div>
    </div>
  )
}
