import React, { useEffect, useCallback, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, Lightning } from '@phosphor-icons/react'
import { GitPanel } from './components/GitPanel'
import { StatusDrawer } from './components/StatusDrawer'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar, useBashModeStore } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { TerminalPanel } from './components/TerminalPanel'
import { TerminalBigScreen } from './components/TerminalBigScreen'
import { ConversationErrorBoundary } from './components/conversation'
import { FileExplorer } from './components/FileExplorer'
import { FileEditor } from './components/FileEditor'
import { QuickToolsTray } from './components/QuickToolsTray'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { CommandPalette } from './components/CommandPalette'
import { CloseTabConfirmDialog } from './components/CloseTabConfirmDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { RemoteDirectoryPicker } from './components/RemoteDirectoryPicker'
import { useRemoteFsStore } from './stores/remote-fs-store'
import { useEngineEvents } from './hooks/useEngineEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useThemeSync } from './hooks/useThemeSync'
import { useTrayMenuListeners } from './hooks/useTrayMenuListeners'
import { useTabRestoration } from './hooks/useTabRestoration'
import { useEnginePermissionDenialBackfill } from './hooks/useEnginePermissionDenialBackfill'
import { useClickThrough } from './hooks/useClickThrough'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useWindowHeight, useInputRowHeight } from './hooks/useWindowGeometry'
import { useSessionStore, editorDirForTab } from './stores/sessionStore'
import { useColors, spacing } from './theme'
import { usePreferencesStore } from './preferences'
import { useUpdateStore } from './stores/update-store'
import { setupModelSync } from './stores/model-store'
import { initActiveTabNotifier } from './lib/active-tab-notifier'
import { initRemoteProjectionPush } from './stores/remote-projection-push'
import { rWarn } from './rendererLogger'


const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export default function App() {
  useEngineEvents()
  useHealthReconciliation()
  useThemeSync()
  useTrayMenuListeners()
  useTabRestoration()
  useEnginePermissionDenialBackfill()
  useClickThrough()

  // Publish the active tab to the main process (desktop.focus resource +
  // Agent Team Visualizer targeting) on startup and on every change.
  useEffect(() => {
    return initActiveTabNotifier()
  }, [])

  // Push the remote tab-state projection to the main process on store change
  // (renderer-push snapshot architecture; replaces the 5 s executeJavaScript
  // poll). No-ops in the ATV mirror window — owner-only push.
  useEffect(() => {
    return initRemoteProjectionPush()
  }, [])

  // Conversation-picker selections from the ATV window: switch the desktop
  // tab so both surfaces stay on the same conversation.
  useEffect(() => {
    return window.ion.onAtvFocusTab((tabId) => {
      useSessionStore.getState().selectTab(tabId)
    })
  }, [])

  // Click-to-inspect from the ATV window: switch to the tab, then ask the
  // agent panel to open that agent's dispatch detail (same as clicking the
  // agent's row).
  useEffect(() => {
    return window.ion.onAtvFocusAgent((tabId, agentName) => {
      useSessionStore.getState().selectTab(tabId)
      // The orchestrator has no dispatch panel — it IS the main conversation,
      // so switching the tab (with the overlay shown by main) is the whole
      // action. Named agents additionally open their dispatch detail.
      if (agentName !== '__orchestrator__') {
        window.dispatchEvent(new CustomEvent('ion:open-agent-detail', { detail: { agentName } }))
      }
    })
  }, [])

  // Listen for auto-update download notifications from the main process
  useEffect(() => {
    return window.ion.onUpdateDownloaded((info) => {
      useUpdateStore.getState().setAvailable(info.version)
    })
  }, [])

  // Set up background model sync (initial fetch, periodic refresh, IPC listener)
  useEffect(() => {
    setupModelSync()
  }, [])

  // Load persisted read-resource IDs from the main process so the
  // notifications panel shows correct read/unread state on startup.
  useEffect(() => {
    window.ion.getReadResourceIds().then((ids: string[]) => {
      if (ids.length > 0) {
        useSessionStore.setState({ readResourceIds: new Set(ids) })
      }
    }).catch((err) => rWarn('resources', 'getReadResourceIds failed', { error: String(err) }))
  }, [])

  // Cold-load persisted resources from disk so the notifications panel
  // has data immediately, even if engine subscriptions fail or return
  // empty (e.g. extension subprocess crash-loops during startup).
  useEffect(() => {
    window.ion.getPersistedResources().then((items: any[]) => {
      if (items.length > 0) {
        const byKind: Record<string, any[]> = {}
        const readIds: string[] = []
        for (const item of items) {
          if (!byKind[item.kind]) byKind[item.kind] = []
          byKind[item.kind].push(item)
          if (item.read) readIds.push(item.id)
        }
        useSessionStore.setState((state) => {
          // Merge: don't overwrite if engine subscriptions already populated
          const merged = { ...state.resources }
          for (const [kind, kindItems] of Object.entries(byKind)) {
            if (!merged[kind] || merged[kind].length === 0) {
              merged[kind] = kindItems
            }
          }
          const mergedReadIds = new Set(state.readResourceIds)
          for (const id of readIds) mergedReadIds.add(id)
          return { resources: merged, readResourceIds: mergedReadIds }
        })
      }
    }).catch((err) => rWarn('resources', 'getPersistedResources failed', { error: String(err) }))
  }, [])

  // Initialize remote-fs store (queries main for isRemote)
  useEffect(() => {
    void useRemoteFsStore.getState().init()
  }, [])

  const [closeConfirmTab, setCloseConfirmTab] = useState<{ id: string; title: string; directory: string } | null>(null)
  useKeyboardShortcuts(setCloseConfirmTab)

  const settingsOpen = useSessionStore((s) => s.settingsOpen)
  const settingsInitialTab = useSessionStore((s) => s.settingsInitialTab)
  const activeTabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const colors = useColors()
  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  const ultraWide = usePreferencesStore((s) => s.ultraWide)
  const bashModeActive = useBashModeStore((s) => s.active)
  const quickTools = usePreferencesStore((s) => s.quickTools)
  const [quickToolsTrayOpen, setQuickToolsTrayOpen] = useState(false)
  const quickToolsBtnRef = React.useRef<HTMLButtonElement>(null)

  const isExpanded = useSessionStore((s) => s.isExpanded)
  const isTallView = useSessionStore((s) => s.tallViewTabId === s.activeTabId)
  const isTerminalTall = useSessionStore((s) => s.terminalTallTabId === s.activeTabId)
  const isTerminalBigScreen = useSessionStore((s) => s.terminalBigScreenTabId === s.activeTabId)
  const gitPanelOpen = useSessionStore((s) => s.gitPanelOpen)
  const statusDrawerOpen = useSessionStore((s) => s.statusDrawerOpen)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const isTerminalOnly = activeTab?.isTerminalOnly || false
  // A conversation tab is any non-terminal tab. The unified ConversationView is
  // mounted for all of them (plain or extension-backed), so the card-shell uses
  // the expanded geometry whenever a conversation is shown — there is no longer
  // an engine-specific layout fork.
  const isConversation = !!activeTab && !isTerminalOnly
  // Tall mode for the active conversation tab. `isTallView` (above) already
  // tracks tallViewTabId === activeTabId for every tab type; `isTall` aliases it
  // for the conversation body height (replaces the old engine-only tall flag).
  const isTall = isTallView && isConversation
  const terminalOpen = useSessionStore((s) => s.terminalOpenTabIds.has(s.activeTabId))
  const explorerOpen = useSessionStore((s) => s.fileExplorerOpenDirs.has(s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''))
  const editorOpen = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return false
    const dir = editorDirForTab(tab)
    return s.fileEditorOpenDirs.has(dir)
  })
  const editorDirState = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return undefined
    const dir = editorDirForTab(tab)
    return s.fileEditorStates.get(dir)
  })
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'

  // When editor is open for this tab but the current dir has no files
  // (e.g. base directory changed), auto-create a scratch file so the editor stays visible
  const activeTabDir = activeTab ? editorDirForTab(activeTab) : undefined

  useEffect(() => {
    if (!editorOpen || !activeTab) return
    const dir = editorDirForTab(activeTab)
    const dirState = useSessionStore.getState().fileEditorStates.get(dir)
    if (!dirState || dirState.files.length === 0) {
      useSessionStore.getState().createScratchFile(dir)
    }
  }, [editorOpen, activeTab, activeTabDir])

  // Fire get_context_breakdown when the status drawer opens so the breakdown
  // panel always shows current data — even for idle or freshly-loaded historical
  // conversations that have not sent a prompt yet. The engine emits
  // engine_context_breakdown on its event bus; the existing context_breakdown
  // handler in event-wiring.ts populates activeInstance.contextBreakdown and
  // the drawer re-renders synchronously.
  useEffect(() => {
    if (!statusDrawerOpen || !activeTabId || activeTabId === '') return
    window.ion.engineGetContextBreakdown(activeTabId).catch(() => {
      // Fire-and-forget. Failure is non-fatal: the drawer renders whatever
      // cached breakdown it has (possibly none for brand-new sessions).
    })
  }, [statusDrawerOpen, activeTabId])

  // Layout dimensions — three width tiers based on expandedUI + ultraWide
  //   ultraWide OFF: collapsed 460 / expanded 700
  //   ultraWide ON:  collapsed 700 / expanded 910
  const baseWidth = ultraWide ? 700 : spacing.contentWidth
  const fullWidth = ultraWide ? 910 : 700
  const contentWidth = expandedUI ? fullWidth : baseWidth
  const cardExpandedWidth = expandedUI ? fullWidth : baseWidth
  const cardCollapsedWidth = expandedUI ? (fullWidth - 30) : (baseWidth - 30)
  const cardCollapsedMargin = 15

  const winHeight = useWindowHeight()
  const inputRowRef = useRef<HTMLDivElement>(null)
  const inputRowHeight = useInputRowHeight(inputRowRef)

  // In tall view: fill available vertical space dynamically
  // NON_INPUT_OVERHEAD covers tab strip (~40px) + card border/margins (~12px) + safety buffer (~38px)
  const NON_INPUT_OVERHEAD = 90
  const tallBodyMax = winHeight - NON_INPUT_OVERHEAD - inputRowHeight


  const handleMainUIMouseDown = useCallback(() => {
    if (useSessionStore.getState().fileEditorFocused) {
      useSessionStore.getState().blurFileEditor()
    }
  }, [])

  const handleScreenshot = useCallback(async () => {
    const result = await window.ion.takeScreenshot()
    if (!result) return
    addAttachments([result])
  }, [addAttachments])

  const handleAttachFile = useCallback(async () => {
    const files = await window.ion.attachFiles()
    if (!files || files.length === 0) return
    addAttachments(files)
  }, [addAttachments])

  return (
    <PopoverLayerProvider>
      {/* Shared ⌘K palette (also mounted in the ATV shell — parity by
          construction); this surface contributes the cross-link action. */}
      <CommandPalette
        actions={[
          { id: 'act:atv', label: 'Open Visualizer', keywords: 'atv office agents', section: 'Actions', run: () => window.ion.atvOpen() },
        ]}
      />
      <div className="flex flex-col justify-end h-full" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div onMouseDown={handleMainUIMouseDown} style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)' }}>

          <AnimatePresence initial={false}>
            {settingsOpen && (
              <SettingsDialog initialTab={settingsInitialTab} onClose={() => useSessionStore.getState().closeSettings()} />
            )}
          </AnimatePresence>

          {closeConfirmTab && (
            <CloseTabConfirmDialog
              title={closeConfirmTab.title}
              directory={closeConfirmTab.directory}
              onConfirm={() => {
                useSessionStore.getState().closeTab(closeConfirmTab.id)
                setCloseConfirmTab(null)
              }}
              onCancel={() => setCloseConfirmTab(null)}
            />
          )}

          {/* ─── Terminal panel ─── */}
          {/* Normal mode: above conversation, hidden in tall/terminal-tall/big-screen view */}
          <AnimatePresence initial={false}>
            {tabsReady && terminalOpen && !isTallView && !isTerminalTall && !isTerminalOnly && !isTerminalBigScreen && (
              <motion.div
                data-ion-ui
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={TRANSITION}
                style={{ marginBottom: 10, position: 'relative', zIndex: 20 }}
              >
                <div
                  data-ion-ui
                  className="glass-surface overflow-hidden"
                  style={{
                    width: cardExpandedWidth,
                    borderRadius: 20,
                    background: colors.containerBg,
                    border: `1px solid ${colors.containerBorder}`,
                    boxShadow: colors.cardShadow,
                    height: 420,
                  }}
                >
                  {activeTab && (
                    <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ─── Tabs / message shell ─── */}
          <motion.div
            data-ion-ui
            className="overflow-hidden flex flex-col"
            animate={{
              width: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? 10 : -14,
              marginLeft: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? 0 : cardCollapsedMargin,
              marginRight: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? 0 : cardCollapsedMargin,
              background: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? 20 : 10,
            }}
          >
            {tabsReady && (<>
            {/* Tab strip — always mounted */}
            <div>
              <TabStrip />
            </div>

            {/* Unified conversation view for EVERY non-terminal tab — plain
                or extension-backed. There is no separate engine view; the one
                ConversationView renders all features from data (agent panel,
                dialog, toasts, pinned prompt, search, todo, queue, activity)
                and self-hides engine-only chrome when its data is empty. Uses
                the always-present fixed-height geometry for all conversations
                (no collapse-to-0). */}
            {!isTerminalOnly && !isTerminalTall && activeTab && (
              <div style={{ height: isTall ? tallBodyMax : 420 }}>
                <ConversationErrorBoundary>
                  <ConversationView tabId={activeTabId} />
                </ConversationErrorBoundary>
              </div>
            )}

            {/* Terminal-only tab: full terminal, no conversation */}
            {isTerminalOnly && !isTerminalBigScreen && activeTab && (
              <div style={{ height: isTerminalTall ? tallBodyMax : 420 }}>
                <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
              </div>
            )}

            {/* Terminal tall mode: terminal replaces conversation */}
            {!isTerminalOnly && isTerminalTall && !isTerminalBigScreen && terminalOpen && activeTab && (
              <div style={{ height: tallBodyMax }}>
                <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
              </div>
            )}
            {/* Unified status bar. Single instance, always rendered at
                the bottom of the active tab body regardless of tab
                type (conversation, engine, terminal-only, terminal-tall).
                Every state read inside StatusBar derives from
                `s.activeTabId` so one mount serves them all — no need
                for per-branch mounts or a hidden zero-size mount to
                keep useGitRepo subscribed. */}
            <StatusBar />
            </>)}
          </motion.div>

          {/* ─── Input row — circles float outside left ─── */}
          {/* Hidden when terminal-only tab (no conversation input needed) */}
          {/* marginBottom: shadow buffer so the glass-surface drop shadow isn't clipped at the native window edge */}
          <div ref={inputRowRef} data-ion-ui className="relative" style={{ minHeight: isTerminalOnly ? 20 : 46, zIndex: 15, marginBottom: isTerminalOnly ? 20 : 60, pointerEvents: isTerminalOnly ? 'none' : undefined, opacity: isTerminalOnly ? 0 : 1 }}>
            {/* Stacked circle buttons — expand on hover */}
            <div
              data-ion-ui
              className="circles-out"
            >
              <div className={`btn-stack${quickTools.length > 0 ? ' has-3' : ''}`}>
                {/* btn-1: Attach (front, rightmost) */}
                <button
                  className="stack-btn stack-btn-1 glass-surface"
                  title="Attach file"
                  onClick={handleAttachFile}
                  disabled={isRunning}
                >
                  <Paperclip size={17} />
                </button>
                {/* btn-2: Screenshot (middle) */}
                <button
                  className="stack-btn stack-btn-2 glass-surface"
                  title="Take screenshot"
                  onClick={handleScreenshot}
                  disabled={isRunning}
                >
                  <Camera size={17} />
                </button>
                {/* btn-3: Quick Tools (back, leftmost) */}
                {quickTools.length > 0 && (
                  <button
                    ref={quickToolsBtnRef}
                    className="stack-btn stack-btn-3 glass-surface"
                    title="Quick Tools"
                    onClick={() => setQuickToolsTrayOpen((o) => !o)}
                  >
                    <Lightning size={17} weight="fill" />
                  </button>
                )}
              </div>
              {quickToolsTrayOpen && (
                <QuickToolsTray
                  anchorRef={quickToolsBtnRef}
                  onClose={() => setQuickToolsTrayOpen(false)}
                />
              )}
            </div>

            {/* Input pill */}
            <div
              data-ion-ui
              className="glass-surface w-full"
              style={{ minHeight: 50, borderRadius: 25, padding: '0 6px 0 16px', background: colors.inputPillBg, boxShadow: bashModeActive ? 'inset 0 0 0 2px rgba(244, 114, 182, 0.5)' : undefined, transition: 'box-shadow 0.15s' }}
            >
              <InputBar />
            </div>
          </div>
          {/* File explorer — anchored to left edge of content column */}
          <AnimatePresence>
            {tabsReady && explorerOpen && (
              <motion.div
                data-ion-ui
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={TRANSITION}
                style={{
                  position: 'absolute',
                  right: '100%',
                  bottom: 60,
                  marginRight: 8,
                  width: 240,
                  zIndex: 25,
                }}
              >
                <FileExplorer />
              </motion.div>
            )}
          </AnimatePresence>
          {/* Git side panel — anchored to right edge of content column */}
          <AnimatePresence>
            {tabsReady && gitPanelOpen && (
              <motion.div
                data-ion-ui
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={TRANSITION}
                style={{
                  position: 'absolute',
                  left: '100%',
                  bottom: 60,
                  marginLeft: 8,
                  width: 280,
                  zIndex: 25,
                }}
              >
                <GitPanel />
              </motion.div>
            )}
          </AnimatePresence>
          {/* Status Drawer — right-side panel, toggled by ⓘ in StatusBar */}
          <AnimatePresence>
            {tabsReady && statusDrawerOpen && (
              <motion.div
                data-ion-ui
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={TRANSITION}
                style={{
                  position: 'absolute',
                  left: '100%',
                  bottom: 60,
                  marginLeft: gitPanelOpen ? 296 : 8,
                  zIndex: 26,
                }}
              >
                <StatusDrawer />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* File editor floating panel */}
        {tabsReady && editorOpen && editorDirState && editorDirState.files.length > 0 && activeTab && (
          <FileEditor dir={editorDirForTab(activeTab)} tabId={activeTabId} />
        )}

        {/* Terminal big screen overlay */}
        {tabsReady && isTerminalBigScreen && (
          <TerminalBigScreen tabId={activeTabId} />
        )}

        {/* Auto-update install dialog */}
        <UpdateDialog />

        {/* Engine-host filesystem picker (used when the engine is remote) */}
        <RemoteDirectoryPicker />
      </div>
    </PopoverLayerProvider>
  )
}
