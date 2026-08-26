import React, { useEffect, useCallback, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, Lightning } from '@phosphor-icons/react'
import { GitPanel } from './components/GitPanel'
import { FILE_EXPLORER_WIDTH, GIT_PANEL_WIDTH, INBOX_PANEL_WIDTH, PANEL_GAP, STATUS_DRAWER_WIDTH } from './components/panelGeometry'
import { OVERLAY_COMPOSER_LAYER, OVERLAY_CONVERSATION_LAYER } from './components/composerLayout'
import { StatusDrawer } from './components/StatusDrawer'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { QuestionsOverlayHost } from './components/questions/QuestionsOverlayHost'
import { hydrateQuestions } from './stores/questions-store'
import { InputBar, useBashModeStore } from './components/InputBar'
import { SettingsDialog } from './components/SettingsDialog'
import { TerminalPanel } from './components/TerminalPanel'
import { TerminalBigScreen } from './components/TerminalBigScreen'
import { AppOverlays } from './components/AppOverlays'
import { ConversationErrorBoundary } from './components/conversation'
import { FileExplorer } from './components/FileExplorer'
import { InboxPanel } from './components/InboxPanel'
import { FileEditor } from './components/FileEditor'
import { QuickToolsTray } from './components/QuickToolsTray'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { CommandPalette } from './components/CommandPalette'
import { CloseTabConfirmDialog } from './components/CloseTabConfirmDialog'
import { useRemoteFsStore } from './stores/remote-fs-store'
import { useEngineEvents } from './hooks/useEngineEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useTrayMenuListeners } from './hooks/useTrayMenuListeners'
import { useTabRestoration } from './hooks/useTabRestoration'
import { useOwnerBootstrap } from './hooks/useOwnerBootstrap'
import { useEnginePermissionDenialBackfill } from './hooks/useEnginePermissionDenialBackfill'
import { useClickThrough } from './hooks/useClickThrough'
import { useWorktreeRendererListeners } from './hooks/useWorktreeRendererListeners'
import { useWorktreeRemoteCommandListeners } from './hooks/useWorktreeRemoteCommandListeners'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useWindowHeight, useWindowWidth, useInputRowHeight } from './hooks/useWindowGeometry'
import { resolveOverlayPanelPlacement, resolveViewportContentWidth } from './responsive-layout'
import { useSessionStore, editorDirForTab } from './stores/sessionStore'
import { useColors, spacing } from './theme'
import { usePreferencesStore } from './preferences'
import { useUpdateEvents } from './hooks/useUpdateEvents'
import { setupModelSync } from './stores/model-store'
import { initActiveTabNotifier } from './lib/active-tab-notifier'
import { initRemoteProjectionPush } from './stores/remote-projection-push'
import { rError } from './rendererLogger'
import { resolveOverlayBodyHeights } from './overlay-body-height'


const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export default function App() {
  useEngineEvents()
  useHealthReconciliation()
  useTrayMenuListeners()
  useTabRestoration()
  useEnginePermissionDenialBackfill()
  useClickThrough()
  useWorktreeRendererListeners()
  useWorktreeRemoteCommandListeners()
  useOwnerBootstrap()

  // Publish the active tab to the main process (desktop.focus resource +
  // Agent Team Visualizer targeting) on startup and on every change.
  useEffect(() => {
    return initActiveTabNotifier()
  }, [])

  // Guided Questions: hydrate the window-local cache from main and subscribe
  // to authoritative broadcasts (view-readiness: the card must be correct on
  // first paint after a window open mid-workflow).
  useEffect(() => {
    return hydrateQuestions()
  }, [])

  // Push the remote tab-state projection to the main process on store change
  // (renderer-push snapshot architecture; replaces the 5 s executeJavaScript
  // poll). No-ops in the STUDIO mirror window — owner-only push.
  useEffect(() => {
    return initRemoteProjectionPush()
  }, [])

  // iOS asked to open a conversation in a worktree or the bench, retire a
  // worktree, or open a bench conversation/terminal — see
  // `useWorktreeRemoteCommandListeners` for all of these.

  // Conversation-picker selections from the STUDIO window: switch the desktop
  // tab so both surfaces stay on the same conversation.
  useEffect(() => {
    return window.ion.onStudioFocusTab((tabId) => {
      useSessionStore.getState().selectTab(tabId)
    })
  }, [])

  // Click-to-inspect from the STUDIO window: switch to the tab, then ask the
  // agent panel to open that agent's dispatch detail (same as clicking the
  // agent's row).
  useEffect(() => {
    return window.ion.onStudioFocusAgent((tabId, agentName) => {
      useSessionStore.getState().selectTab(tabId)
      // The orchestrator has no dispatch panel — it IS the main conversation,
      // so switching the tab (with the overlay shown by main) is the whole
      // action. Named agents additionally open their dispatch detail.
      if (agentName !== '__orchestrator__') {
        window.dispatchEvent(new CustomEvent('ion:open-agent-detail', { detail: { agentName } }))
      }
    })
  }, [])

  useUpdateEvents()

  // Set up background model sync (initial fetch, periodic refresh, IPC listener)
  useEffect(() => {
    setupModelSync()
  }, [])

  // Initialize remote-fs store (queries main for isRemote)
  useEffect(() => {
    void useRemoteFsStore.getState().init()
  }, [])

  // The close dialog is driven entirely by the store's closeIntent: every entry
  // point (pill X, group pill, middle-click, Cmd+W) calls requestCloseTab, which
  // resolves the worktree warning and raises the intent. One confirm surface,
  // so a new entry point cannot introduce a third close behaviour.
  const closeIntent = useSessionStore((s) => s.closeIntent)
  const [paletteOpen, setPaletteOpen] = useState(false)
  useKeyboardShortcuts(() => setPaletteOpen((open) => !open))

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
  const inboxPanelOpen = useSessionStore((s) => s.inboxPanelOpen)
  const statusDrawerOpen = useSessionStore((s) => s.statusDrawerOpen)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabsReady = useSessionStore((s) => s.tabsReady)
  const startupReady = useSessionStore((s) => s.startupReady)
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
  const winWidth = useWindowWidth()
  const responsiveContentWidth = resolveViewportContentWidth(contentWidth, winWidth)
  const responsiveCardWidth = resolveViewportContentWidth(cardExpandedWidth, winWidth)
  const inboxPlacement = resolveOverlayPanelPlacement(winWidth, responsiveContentWidth, INBOX_PANEL_WIDTH, PANEL_GAP)
  const explorerPlacement = resolveOverlayPanelPlacement(winWidth, responsiveContentWidth, FILE_EXPLORER_WIDTH, PANEL_GAP)
  const gitPlacement = resolveOverlayPanelPlacement(winWidth, responsiveContentWidth, GIT_PANEL_WIDTH, PANEL_GAP)
  const statusPlacement = resolveOverlayPanelPlacement(winWidth, responsiveContentWidth, STATUS_DRAWER_WIDTH, PANEL_GAP)
  const inputRowRef = useRef<HTMLDivElement>(null)
  const inputRowHeight = useInputRowHeight(inputRowRef)

  // In tall view: fill available vertical space dynamically
  // NON_INPUT_OVERHEAD covers tab strip (~40px) + card border/margins (~12px) + safety buffer (~38px)
  const NON_INPUT_OVERHEAD = 90
  const tallBodyMax = Math.max(96, winHeight - NON_INPUT_OVERHEAD - inputRowHeight)
  const normalBodies = resolveOverlayBodyHeights(
    winHeight,
    inputRowHeight,
    terminalOpen && !isTallView && !isTerminalTall && !isTerminalOnly && !isTerminalBigScreen,
  )


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

  if (!startupReady) return null

  return (
    <PopoverLayerProvider>
      {/* Shared ⌘K palette (also mounted in the STUDIO shell — parity by
          construction); this surface contributes the cross-link action. */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={[
          { id: 'act:studio', label: 'Open Ion Studio', keywords: 'studio office agents', section: 'Actions', run: () => window.ion.studioOpen() },
        ]}
      />
      <div className="flex flex-col h-full overflow-hidden" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div onMouseDown={handleMainUIMouseDown} style={{ width: responsiveContentWidth, maxWidth: '100%', position: 'relative', margin: 'auto auto 0', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)' }}>

          <AnimatePresence initial={false}>
            {settingsOpen && (
              <SettingsDialog initialTab={settingsInitialTab} onClose={() => useSessionStore.getState().closeSettings()} />
            )}
          </AnimatePresence>

          {closeIntent && (
            <CloseTabConfirmDialog
              title={closeIntent.title}
              directory={closeIntent.directory}
              warning={closeIntent.warning}
              onConfirm={() => useSessionStore.getState().confirmCloseTab()}
              onCancel={() => useSessionStore.getState().cancelCloseTab()}
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
                  className="glass-surface ion-theme-backdrop overflow-hidden"
                  style={{
                    width: responsiveCardWidth,
                    maxWidth: '100%',
                    borderRadius: 20,
                    background: colors.containerBg,
                    border: `1px solid ${colors.containerBorder}`,
                    boxShadow: colors.cardShadow,
                    height: normalBodies.terminal,
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
            className="ion-theme-backdrop overflow-hidden flex flex-col"
            animate={{
              width: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? responsiveCardWidth : Math.min(cardCollapsedWidth, responsiveCardWidth),
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
              zIndex: isExpanded || isTerminalOnly || isTerminalTall || isConversation ? OVERLAY_CONVERSATION_LAYER : 10,
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
              <div style={{ height: isTall ? tallBodyMax : normalBodies.conversation }}>
                <ConversationErrorBoundary>
                  <ConversationView key={activeTabId} tabId={activeTabId} />
                </ConversationErrorBoundary>
              </div>
            )}

            {/* Terminal-only tab: full terminal, no conversation */}
            {isTerminalOnly && !isTerminalBigScreen && activeTab && (
              <div style={{ height: isTerminalTall ? tallBodyMax : normalBodies.conversation }}>
                <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
              </div>
            )}

            {/* Terminal tall mode: terminal replaces conversation */}
            {!isTerminalOnly && isTerminalTall && !isTerminalBigScreen && terminalOpen && activeTab && (
              <div style={{ height: tallBodyMax }}>
                <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
              </div>
            )}
            </>)}
          </motion.div>

          {/* ─── Guided Questions card — pinned above the input row ─── */}
          {/* Overlay-owned mount, deliberately OUTSIDE ConversationView so the
              Studio shell (which mounts the same wizard via QuestionsSurface)
              never double-renders it. Renders nothing without an open
              workflow on the active conversation. */}
          {!isTerminalOnly && <QuestionsOverlayHost />}

          {/* ─── Input row — circles float outside left ─── */}
          {/* Hidden when terminal-only tab (no conversation input needed) */}
          {/* marginBottom: shadow buffer so the glass-surface drop shadow isn't clipped at the native window edge */}
          {/* The preview rail expands this row upward. Stacking must stay above
              conversation chrome, otherwise queued pasted attachments exist
              but are painted behind the transcript. */}
          <div ref={inputRowRef} data-ion-ui className="relative" style={{ minHeight: isTerminalOnly ? 20 : 46, zIndex: OVERLAY_COMPOSER_LAYER, marginBottom: isTerminalOnly ? 20 : 60, pointerEvents: isTerminalOnly ? 'none' : undefined, opacity: isTerminalOnly ? 0 : 1 }}>
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
                  onClick={() => { void handleAttachFile().catch((err) => rError('app', 'handleAttachFile failed', { error: String(err) })) }}
                  disabled={isRunning}
                >
                  <Paperclip size={17} />
                </button>
                {/* btn-2: Screenshot (middle) */}
                <button
                  className="stack-btn stack-btn-2 glass-surface"
                  title="Take screenshot"
                  onClick={() => { void handleScreenshot().catch((err) => rError('app', 'handleScreenshot failed', { error: String(err) })) }}
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
              className="glass-surface ion-input-shell w-full"
              style={{ minHeight: 50, borderRadius: 25, padding: '0 6px 0 16px', background: colors.inputPillBg, boxShadow: bashModeActive ? `inset 0 0 0 2px ${colors.bashModeRing}` : undefined }}
            >
              <InputBar />
            </div>
          </div>
          {/* Inbox and File Explorer share the left edge. Store actions keep
              exactly one open, so both use the same geometry without overlap. */}
          <AnimatePresence>
            {tabsReady && inboxPanelOpen && (
              <motion.div
                data-ion-ui
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={TRANSITION}
                style={{ position: 'absolute', right: inboxPlacement.external ? '100%' : 'auto', left: inboxPlacement.external ? 'auto' : 0, bottom: 60, marginRight: inboxPlacement.external ? 8 : 0, width: inboxPlacement.width, maxWidth: '100%', zIndex: 25 }}
              >
                <InboxPanel onClose={() => useSessionStore.getState().closeInboxPanel()} />
              </motion.div>
            )}
          </AnimatePresence>
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
                  right: explorerPlacement.external ? '100%' : 'auto',
                  left: explorerPlacement.external ? 'auto' : 0,
                  bottom: 60,
                  marginRight: explorerPlacement.external ? 8 : 0,
                  width: explorerPlacement.width,
                  maxWidth: '100%',
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
                  left: gitPlacement.external ? '100%' : 0,
                  bottom: 60,
                  marginLeft: gitPlacement.external ? PANEL_GAP : 0,
                  width: gitPlacement.width,
                  maxWidth: '100%',
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
                  left: statusPlacement.external ? '100%' : 0,
                  bottom: 60,
                  marginLeft: statusPlacement.external ? PANEL_GAP : 0,
                  width: statusPlacement.width,
                  maxWidth: '100%',
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

        {/* App-level singleton overlays (deep-link approval, update dialog,
            remote directory picker). See AppOverlays.tsx for why
            each is mounted unconditionally and outside the tabsReady gate. */}
        <AppOverlays />
      </div>
    </PopoverLayerProvider>
  )
}
