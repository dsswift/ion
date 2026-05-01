import React, { useEffect, useCallback, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, Lightning } from '@phosphor-icons/react'
import { GitPanel } from './components/GitPanel'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar, useBashModeStore } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { TerminalPanel } from './components/TerminalPanel'
import { TerminalBigScreen } from './components/TerminalBigScreen'
import { EngineView } from './components/EngineView'
import { FileExplorer } from './components/FileExplorer'
import { FileEditor } from './components/FileEditor'
import { QuickToolsTray } from './components/QuickToolsTray'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { CloseTabConfirmDialog } from './components/CloseTabConfirmDialog'
import { useEngineEvents } from './hooks/useEngineEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useThemeSync } from './hooks/useThemeSync'
import { useTrayMenuListeners } from './hooks/useTrayMenuListeners'
import { useTabRestoration } from './hooks/useTabRestoration'
import { useClickThrough } from './hooks/useClickThrough'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useWindowHeight, useInputRowHeight } from './hooks/useWindowGeometry'
import { useSessionStore, editorDirForTab } from './stores/sessionStore'
import { useColors, spacing } from './theme'
import { usePreferencesStore } from './preferences'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export default function App() {
  useEngineEvents()
  useHealthReconciliation()
  useThemeSync()
  useTrayMenuListeners()
  useTabRestoration()
  useClickThrough()

  const [closeConfirmTab, setCloseConfirmTab] = useState<{ id: string; title: string; directory: string } | null>(null)
  useKeyboardShortcuts(setCloseConfirmTab)

  const settingsOpen = useSessionStore((s) => s.settingsOpen)
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
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const isTerminalOnly = activeTab?.isTerminalOnly || false
  const isEngine = activeTab?.isEngine || false
  const isEngineTall = useSessionStore((s) => s.tallViewTabId === s.activeTabId && (s.tabs.find((t) => t.id === s.activeTabId)?.isEngine || false))
  const terminalOpen = useSessionStore((s) => s.terminalOpenTabIds.has(s.activeTabId))
  const explorerOpen = useSessionStore((s) => s.fileExplorerOpenDirs.has(s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''))
  const editorOpen = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab ? s.fileEditorOpenDirs.has(editorDirForTab(tab)) : false
  })
  const editorDirState = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab ? s.fileEditorStates.get(editorDirForTab(tab)) : undefined
  })
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'

  // When editor is open for this tab but the current dir has no files
  // (e.g. base directory changed), auto-create a scratch file so the editor stays visible
  useEffect(() => {
    if (!editorOpen || !activeTab) return
    const dir = editorDirForTab(activeTab)
    const dirState = useSessionStore.getState().fileEditorStates.get(dir)
    if (!dirState || dirState.files.length === 0) {
      useSessionStore.getState().createScratchFile(dir)
    }
  }, [editorOpen, activeTab ? editorDirForTab(activeTab) : undefined])

  // Layout dimensions — three width tiers based on expandedUI + ultraWide
  //   ultraWide OFF: collapsed 460 / expanded 700
  //   ultraWide ON:  collapsed 700 / expanded 910
  const baseWidth = ultraWide ? 700 : spacing.contentWidth
  const fullWidth = ultraWide ? 910 : 700
  const contentWidth = expandedUI ? fullWidth : baseWidth
  const cardExpandedWidth = expandedUI ? fullWidth : baseWidth
  const cardCollapsedWidth = expandedUI ? (fullWidth - 30) : (baseWidth - 30)
  const cardCollapsedMargin = 15
  const bodyMaxHeightNormal = expandedUI ? 520 : 400

  const winHeight = useWindowHeight()
  const inputRowRef = useRef<HTMLDivElement>(null)
  const inputRowHeight = useInputRowHeight(inputRowRef)

  // In tall view: fill available vertical space dynamically
  // NON_INPUT_OVERHEAD covers tab strip (~40px) + card border/margins (~12px) + safety buffer (~38px)
  const NON_INPUT_OVERHEAD = 90
  const tallBodyMax = winHeight - NON_INPUT_OVERHEAD - inputRowHeight
  const bodyMaxHeight = isTallView ? tallBodyMax : bodyMaxHeightNormal

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
      <div className="flex flex-col justify-end h-full" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div onMouseDown={handleMainUIMouseDown} style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)' }}>

          <AnimatePresence initial={false}>
            {settingsOpen && (
              <SettingsDialog onClose={() => useSessionStore.getState().closeSettings()} />
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
            {terminalOpen && !isTallView && !isTerminalTall && !isTerminalOnly && !isTerminalBigScreen && (
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
              width: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? 10 : -14,
              marginLeft: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? 0 : cardCollapsedMargin,
              marginRight: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? 0 : cardCollapsedMargin,
              background: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded || isTerminalOnly || isTerminalTall || isEngine ? 20 : 10,
            }}
          >
            {/* Tab strip — always mounted */}
            <div>
              <TabStrip />
            </div>

            {/* Engine tab: custom engine view */}
            {isEngine && activeTab && (
              <div style={{ height: isEngineTall ? tallBodyMax : 420 }}>
                <EngineView tabId={activeTabId} />
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

            {/* Body — chat history (hidden when terminal-only, engine, or terminal-tall) */}
            {!isTerminalOnly && !isEngine && !isTerminalTall && (
              <motion.div
                initial={false}
                animate={{
                  height: isExpanded ? 'auto' : 0,
                  opacity: isExpanded ? 1 : 0,
                }}
                transition={TRANSITION}
                className="overflow-hidden"
              >
                <div style={{ maxHeight: bodyMaxHeight, display: 'flex', flexDirection: 'column' }}>
                  <ConversationView />
                  <StatusBar />
                </div>
              </motion.div>
            )}
            {/* StatusBar must always mount so useGitPolling runs for terminal-only/tall/engine tabs */}
            {(isTerminalOnly || isTerminalTall || isEngine) && (
              <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
                <StatusBar />
              </div>
            )}
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
            {explorerOpen && (
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
            {gitPanelOpen && (
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
        </div>

        {/* File editor floating panel */}
        {editorOpen && editorDirState && editorDirState.files.length > 0 && activeTab && (
          <FileEditor dir={editorDirForTab(activeTab)} tabId={activeTabId} />
        )}

        {/* Terminal big screen overlay */}
        {isTerminalBigScreen && (
          <TerminalBigScreen tabId={activeTabId} />
        )}
      </div>
    </PopoverLayerProvider>
  )
}
