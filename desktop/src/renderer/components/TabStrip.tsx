import React, { useState, useRef, useEffect, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  Terminal, CaretLeft, CaretRight, ChatCircle,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'

import { SettingsPopover } from './SettingsPopover'
import { NotificationsBell } from './NotificationsPanel'
import { AtvLauncherButton } from './AtvLauncherButton'
import { BranchPickerDialog } from './BranchPickerDialog'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { NewConversationPicker, resolveNewConversationAction, executeNewConversationAction } from './NewConversationPicker'
import { createNewConversationTab } from './new-conversation-tab'
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
import { WorkspaceStatusIndicator } from './WorkspaceStatusIndicator'
import { rError } from '../rendererLogger'

export function TabStrip() {
  const tabs = useSessionStore((s) => s.tabs)
  // Subscribe to engine state so the waiting-state border on an engine
  // tab's pill re-renders when any of its sub-instances gets/clears a
  // pending AskUserQuestion / ExitPlanMode denial. getWaitingState()
  // Subscribe to conversationPanes so tab strip pills re-render when instance
  // permissionDenied or other ConversationInstance fields change. With all
  // instance state on conversationPanes, a single subscription covers everything
  // that previously required separate enginePermissionDenied subscription.
  useSessionStore((s) => s.conversationPanes)
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
  const terminalOpenTabIds = useSessionStore((s) => s.terminalOpenTabIds)
  const colors = useColors()
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const enterpriseNewConversationDefaults = usePreferencesStore((s) => s.enterpriseNewConversationDefaults)
  const worktreeUncommittedMap = useSessionStore((s) => s.worktreeUncommittedMap)
  const { mode: groupMode, groups, ungrouped } = useTabGroups()

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [confirmingCloseId, setConfirmingCloseId] = useState<string | null>(null)
  const [colorPickerTabId, setColorPickerTabId] = useState<string | null>(null)
  const [colorPickerAnchor, setColorPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirMenuTabId, setDirMenuTabId] = useState<string | null>(null)
  const [dirMenuAnchor, setDirMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dirPickerState, setDirPickerState] = useState<{ anchor: { x: number; y: number; bottom: number }; mode: 'conversation' | 'terminal' } | null>(null)
  const [convPickerState, setConvPickerState] = useState<{ anchor: { x: number; y: number; bottom: number }; dir: string } | null>(null)
  const [tabMenuId, setTabMenuId] = useState<string | null>(null)
  const [tabMenuAnchor, setTabMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const plusButtonRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Manual drag-to-reorder for flat tab mode
  const flatReorder = useManualReorder({
    items: tabs,
    keyFn: (t) => t.id,
    itemRefs: tabRefs,
    onReorder: reorderTabs,
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
  }, [dirMenuTabId, tabMenuId, tabs])

  // Keyboard shortcut bridge: Cmd+T / Cmd+Shift+T fire this event when the
  // resolved action is 'show-picker' so the picker opens anchored to the +
  // button, matching the click-driven path.
  useEffect(() => {
    const handler = (e: Event) => {
      const dir = (e as CustomEvent<{ dir: string }>).detail?.dir ?? ''
      const btn = plusButtonRef.current
      const raw = btn ? btn.getBoundingClientRect() : new DOMRect(0, 40, 0, 0)
      const rect = zoomRect(raw)
      setConvPickerState({ anchor: { x: rect.left, y: rect.top, bottom: rect.bottom }, dir })
    }
    window.addEventListener('ion:open-new-conversation-picker', handler)
    return () => window.removeEventListener('ion:open-new-conversation-picker', handler)
  }, [])

  // Keyboard shortcut bridge: Cmd+R fires this event so the recent-directories
  // picker opens anchored to the + button, matching the click-driven path.
  useEffect(() => {
    const handler = () => {
      const btn = plusButtonRef.current
      const raw = btn ? btn.getBoundingClientRect() : new DOMRect(0, 40, 0, 0)
      const rect = zoomRect(raw)
      setDirPickerState({ anchor: { x: rect.left, y: rect.top, bottom: rect.bottom }, mode: 'conversation' })
    }
    window.addEventListener('ion:open-recent-dirs', handler)
    return () => window.removeEventListener('ion:open-recent-dirs', handler)
  }, [])

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
    let rafId = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateScrollIndicators)
    })
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollIndicators)
      cancelAnimationFrame(rafId)
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

  // Convert vertical wheel to horizontal scroll via a NATIVE non-passive listener.
  // React's synthetic onWheel is registered as a passive listener in React 17+,
  // so calling e.preventDefault() inside it logs "Unable to preventDefault inside
  // passive event listener invocation" and the default scroll behavior is not
  // suppressed. Registering via addEventListener with { passive: false } gives us
  // a real cancelable wheel event.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      // Wheel events from portaled popovers (e.g. the group picker dropdown) bubble
      // through the DOM even though their target lives in the PopoverLayer, not
      // inside this scroll container. Only act on events whose real DOM target
      // lives inside the scroll container.
      if (!el.contains(e.target as Node)) return
      const delta = e.deltaX || e.deltaY
      if (delta === 0) return
      e.preventDefault()
      el.scrollLeft += delta
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => { el.removeEventListener('wheel', handler) }
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
      onCreateTabInDir={(dir) => {
        createNewConversationTab(dir)
      }}
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
      {/* Global workspace status indicator — two-tier ambient dot (orange=running,
          yellow=background-agents, gray=idle). Placed LEFT of the tab strip so
          it's always visible even when the strip is full. Click opens a popover
          with per-status tab counts. See WorkspaceStatusIndicator.tsx. */}
      <WorkspaceStatusIndicator />

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
              onCreateTab={() => {
                createNewConversationTab(menuTab.workingDirectory)
              }}
              onForkTab={menuTab.conversationId ? () => { void useSessionStore.getState().forkTab(menuTab.id).catch((err) => rError('tabs', 'fork tab failed', { error: String(err) })) } : undefined}
              onFinishWork={menuTab.worktree ? () => { void useSessionStore.getState().finishWorktreeTab(menuTab.id).catch((err) => rError('tabs', 'finish worktree failed', { error: String(err) })) } : undefined}
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
                case 'conversation': {
                  const result = createNewConversationTab(dir)
                  if (result === 'show-picker') {
                    setConvPickerState({ anchor: dirPickerState!.anchor, dir })
                  }
                  break
                }
                case 'terminal': void createTerminalTab(dir).catch((err) => rError('tabs', 'create terminal failed', { error: String(err) })); break
              }
            }}
            onClose={() => setDirPickerState(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {convPickerState && (
          <NewConversationPicker
            key="new-conversation-picker"
            anchor={convPickerState.anchor}
            onPlain={() => {
              void createTabInDirectory(convPickerState.dir, shouldUseWorktree(false)).catch((err) => rError('tabs', 'create tab failed', { error: String(err) }))
              setConvPickerState(null)
            }}
            onProfile={(profileId) => {
              void useSessionStore.getState().createConversationTab(convPickerState.dir, { profileId }).catch((err) => rError('tabs', 'create conversation failed', { error: String(err) }))
              setConvPickerState(null)
            }}
            onOpenSettings={() => {
              window.dispatchEvent(new CustomEvent('ion:open-settings'))
              setConvPickerState(null)
            }}
            onClose={() => setConvPickerState(null)}
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
              onForkTab={menuTab.conversationId ? () => { void useSessionStore.getState().forkTab(menuTab.id).catch((err) => rError('tabs', 'fork tab failed', { error: String(err) })) } : undefined}
              onNewTabInDir={() => {
                if (menuTab.workingDirectory) {
                  createNewConversationTab(menuTab.workingDirectory)
                }
              }}
              onFinishWork={() => {
                void useSessionStore.getState().finishWorktreeTab(menuTab.id).catch((err) => rError('tabs', 'finish worktree failed', { error: String(err) }))
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
              void useSessionStore.getState().setupWorktree(pendingTab.id, branch, setAsDefault).catch((err) => rError('tabs', 'setup worktree failed', { error: String(err) }))
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
            // Check for enterprise lock before opening the directory picker.
            const { engineProfiles, defaultEngineProfileId } = usePreferencesStore.getState()
            const action = resolveNewConversationAction(engineProfiles, defaultEngineProfileId, enterpriseNewConversationDefaults)
            if (action.kind === 'locked') {
              // Locked: bypass both pickers entirely. Open with the mandated dir
              // + profile via the shared executor so the open-logic isn't
              // duplicated here.
              const dir = action.baseDirectory || usePreferencesStore.getState().defaultBaseDirectory
              executeNewConversationAction(
                dir,
                action,
                (d, wt) => { void createTabInDirectory(d, wt).catch((err) => rError('tabs', 'create tab failed', { error: String(err) })) },
                (d, opts) => { void useSessionStore.getState().createConversationTab(d, opts).catch((err) => rError('tabs', 'create conversation failed', { error: String(err) })) },
                shouldUseWorktree(false),
              )
              return
            }
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

        {/* <HistoryPicker /> */}
        <AtvLauncherButton />
        <NotificationsBell />

        <SettingsPopover />
      </div>
    </div>
  )
}
