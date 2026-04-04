import React, { useEffect, useCallback, useState } from 'react'
import type { Message } from '../shared/types'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, HeadCircuit, Lightning } from '@phosphor-icons/react'
import { GitPanel } from './components/GitPanel'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar, useBashModeStore } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { MarketplacePanel } from './components/MarketplacePanel'
import { SettingsDialog } from './components/SettingsDialog'
import { TerminalPanel } from './components/TerminalPanel'
import { TerminalBigScreen } from './components/TerminalBigScreen'
import { setSavedBuffer } from './components/TerminalInstance'
import { FileExplorer } from './components/FileExplorer'
import { FileEditor } from './components/FileEditor'
import { QuickToolsTray } from './components/QuickToolsTray'
import { PopoverLayerProvider, usePopoverLayer } from './components/PopoverLayer'
import { createPortal } from 'react-dom'
import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useSessionStore, editorDirForTab } from './stores/sessionStore'
import { useColors, useThemeStore, spacing } from './theme'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

function CloseTabConfirmDialog({
  title,
  directory,
  onConfirm,
  onCancel,
}: {
  title: string
  directory: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel, onConfirm])

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      data-coda-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <motion.div
        data-coda-ui
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={TRANSITION}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 320,
          borderRadius: 16,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
          Close tab?
        </div>
        <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 500 }}>{title}</div>
          <div style={{ color: colors.textTertiary, marginTop: 2 }}>{directory}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded-lg text-[11px]"
            style={{
              color: colors.textSecondary,
              background: colors.surfacePrimary,
              border: `1px solid ${colors.containerBorder}`,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1 rounded-lg text-[11px]"
            style={{
              color: '#fff',
              background: colors.accent,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}

export default function App() {
  useClaudeEvents()
  useHealthReconciliation()

  const [closeConfirmTab, setCloseConfirmTab] = useState<{ id: string; title: string; directory: string } | null>(null)

  const settingsOpen = useSessionStore((s) => s.settingsOpen)
  const activeTabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const colors = useColors()
  const setSystemTheme = useThemeStore((s) => s.setSystemTheme)
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const ultraWide = useThemeStore((s) => s.ultraWide)
  const bashModeActive = useBashModeStore((s) => s.active)
  const quickTools = useThemeStore((s) => s.quickTools)
  const [quickToolsTrayOpen, setQuickToolsTrayOpen] = useState(false)
  const quickToolsBtnRef = React.useRef<HTMLButtonElement>(null)

  // ─── Theme initialization ───
  useEffect(() => {
    // Get initial OS theme — setSystemTheme respects themeMode (system/light/dark)
    window.coda.getTheme().then(({ isDark }) => {
      setSystemTheme(isDark)
    }).catch(() => {})

    // Listen for OS theme changes
    const unsub = window.coda.onThemeChange((isDark) => {
      setSystemTheme(isDark)
    })
    return unsub
  }, [setSystemTheme])

  // Listen for show-settings IPC from tray menu
  useEffect(() => {
    const unsub = window.coda.onShowSettings(() => {
      useSessionStore.getState().openSettings()
    })
    return unsub
  }, [])

  useEffect(() => {
    useSessionStore.getState().initStaticInfo().then(async () => {
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'

      // Try restoring saved tabs
      const saved = await window.coda.loadTabs().catch(() => null)
      if (saved && saved.tabs && saved.tabs.length > 0) {
        // Restore each saved tab
        const restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }> = []
        for (let i = 0; i < saved.tabs.length; i++) {
          const st = saved.tabs[i]

          if (st.claudeSessionId) {
            // Tab with a Claude session -- resume it
            const tabId = await useSessionStore.getState().resumeSession(
              st.claudeSessionId,
              st.title,
              st.workingDirectory,
            )
            restoredTabIds.push({ tabId, sessionId: st.claudeSessionId, index: i })

            // Patch extra per-tab settings that resumeSession doesn't handle
            // Restore worktree info if present (verify path still exists)
            let restoredWorktree = st.worktree || null
            if (restoredWorktree) {
              try {
                const { entries } = await window.coda.fsReadDir(restoredWorktree.worktreePath)
                // Directory exists, keep the worktree info
              } catch {
                // Worktree was cleaned up externally
                restoredWorktree = null
              }
            }

            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      hasChosenDirectory: st.hasChosenDirectory,
                      additionalDirs: st.additionalDirs,
                      permissionMode: st.permissionMode,
                      bashResults: st.bashResults || [],
                      pillColor: st.pillColor || null,
                      pillIcon: st.pillIcon || null,
                      worktree: restoredWorktree,
                      historicalSessionIds: st.historicalSessionIds || [],
                      groupId: st.groupId || null,
                      contextTokens: st.contextTokens || null,
                      queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                      // If worktree is valid, restore workingDirectory to worktree path
                      // If worktree was cleaned up, fall back to original repo path
                      ...(restoredWorktree
                        ? { workingDirectory: restoredWorktree.worktreePath }
                        : st.worktree ? { workingDirectory: st.worktree.repoPath } : {}),
                    }
                  : t
              ),
            }))
            window.coda.setPermissionMode(tabId, st.permissionMode)
          } else if (st.isTerminalOnly) {
            // Terminal-only tab
            const tabId = await useSessionStore.getState().createTerminalTab()
            restoredTabIds.push({ tabId, sessionId: null, index: i })

            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      workingDirectory: st.workingDirectory,
                      hasChosenDirectory: st.hasChosenDirectory,
                      pillColor: st.pillColor || null,
                      pillIcon: st.pillIcon || 'Terminal',
                      groupId: st.groupId || null,
                    }
                  : t
              ),
            }))

            // Restore terminal instances from persisted state
            if (st.terminalInstances && st.terminalInstances.length > 0) {
              const panes = new Map(useSessionStore.getState().terminalPanes)
              panes.set(tabId, {
                instances: st.terminalInstances,
                activeInstanceId: st.terminalInstances[0].id,
              })
              useSessionStore.setState({ terminalPanes: panes })
              // Pre-populate saved buffers for history restore
              if (st.terminalBuffers) {
                for (const inst of st.terminalInstances) {
                  const buf = st.terminalBuffers[inst.id]
                  if (buf) setSavedBuffer(`${tabId}:${inst.id}`, buf)
                }
              }
            }
          } else {
            // Sessionless tab (e.g. has editor state but no messages sent yet)
            const tabId = await useSessionStore.getState().createTabInDirectory(st.workingDirectory, false, true)
            restoredTabIds.push({ tabId, sessionId: null, index: i })

            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      customTitle: st.customTitle || null,
                      hasChosenDirectory: st.hasChosenDirectory,
                      additionalDirs: st.additionalDirs,
                      permissionMode: st.permissionMode,
                      pillColor: st.pillColor || null,
                      pillIcon: st.pillIcon || null,
                      forkedFromSessionId: st.forkedFromSessionId || null,
                      worktree: st.worktree || null,
                      historicalSessionIds: st.historicalSessionIds || [],
                      groupId: st.groupId || null,
                      contextTokens: st.contextTokens || null,
                      queuedPrompts: st.queuedPrompts?.length ? [st.queuedPrompts.join('\n\n')] : [],
                    }
                  : t
              ),
            }))
            window.coda.setPermissionMode(tabId, st.permissionMode)
          }
        }

        // Load historical session messages for tabs that have them
        for (const { tabId, index } of restoredTabIds) {
          const st = saved.tabs[index]
          const historicalIds = st.historicalSessionIds || []
          if (historicalIds.length > 0) {
            const allHistoricalMessages: Message[] = []
            for (const hid of historicalIds) {
              const history = await window.coda.loadSession(hid, st.workingDirectory).catch(() => [])
              const msgs = history.map((m) => ({
                id: crypto.randomUUID(),
                role: m.role as Message['role'],
                content: m.content,
                toolName: m.toolName,
                toolId: m.toolId,
                toolInput: m.toolInput,
                toolStatus: m.toolName ? 'completed' as const : undefined,
                userExecuted: m.userExecuted,
                attachments: m.attachments,
                timestamp: m.timestamp,
              }))
              allHistoricalMessages.push(...msgs)
            }

            if (allHistoricalMessages.length > 0) {
              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((t) =>
                  t.id === tabId
                    ? { ...t, messages: [...allHistoricalMessages, ...t.messages] }
                    : t
                ),
              }))
            }
          }
        }

        // Restore terminal pane instances for non-terminal-only tabs
        for (const { tabId, index } of restoredTabIds) {
          const st = saved.tabs[index]
          if (!st.isTerminalOnly && st.terminalInstances && st.terminalInstances.length > 0) {
            const panes = new Map(useSessionStore.getState().terminalPanes)
            panes.set(tabId, {
              instances: st.terminalInstances,
              activeInstanceId: st.terminalInstances[0].id,
            })
            useSessionStore.setState({ terminalPanes: panes })
            // Also mark terminal as open so the pane is visible
            useSessionStore.setState((s) => ({
              terminalOpenTabIds: new Set([...s.terminalOpenTabIds, tabId]),
            }))
            // Pre-populate saved buffers for history restore
            if (st.terminalBuffers) {
              for (const inst of st.terminalInstances) {
                const buf = st.terminalBuffers[inst.id]
                if (buf) setSavedBuffer(`${tabId}:${inst.id}`, buf)
              }
            }
          }
        }

        // Set active tab by index (handles both session and sessionless tabs)
        if (typeof saved.activeTabIndex === 'number') {
          const activeEntry = restoredTabIds.find((r) => r.index === saved.activeTabIndex)
          if (activeEntry) {
            useSessionStore.setState({ activeTabId: activeEntry.tabId })
          }
        } else if (saved.activeSessionId) {
          // Backwards compat: fall back to session ID matching
          const activeEntry = restoredTabIds.find((r) => r.sessionId === saved.activeSessionId)
          if (activeEntry) {
            useSessionStore.setState({ activeTabId: activeEntry.tabId })
          }
        }

        // Remove the initial blank tab created by store constructor
        const initialTabId = useSessionStore.getState().tabs[0]?.id
        const isInitialBlank = initialTabId && !restoredTabIds.some((r) => r.tabId === initialTabId)
        if (isInitialBlank) {
          useSessionStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== initialTabId),
          }))
        }

        // Restore editor states (per-directory)
        if (saved.editorStates) {
          const restoredEditorStates = new Map<string, any>()
          for (const [dir, dirState] of Object.entries(saved.editorStates as Record<string, any>)) {
            if (dirState && dirState.files && dirState.files.length > 0) {
              let fileIdCounter = 0
              const files = dirState.files.map((f: any) => ({
                id: `restored-${dir}-${fileIdCounter++}`,
                filePath: f.filePath,
                fileName: f.fileName,
                content: f.content || '',
                savedContent: f.savedContent || '',
                isDirty: f.isDirty || false,
                isReadOnly: f.isReadOnly || false,
                isPreview: f.isPreview || false,
              }))
              // Restore active file by saved index (IDs are regenerated on each restore)
              const savedIdx = typeof dirState.activeFileIndex === 'number' ? dirState.activeFileIndex : 0
              const activeIdx = savedIdx >= 0 && savedIdx < files.length ? savedIdx : 0
              const activeFileId = files.length > 0 ? files[activeIdx].id : null
              restoredEditorStates.set(dir, { activeFileId, files })
            }
          }
          if (restoredEditorStates.size > 0) {
            useSessionStore.setState({ fileEditorStates: restoredEditorStates })
          }
        }

        // Restore which directories had the file editor open
        if (saved.editorOpenDirs && saved.editorOpenDirs.length > 0) {
          useSessionStore.setState({ fileEditorOpenDirs: new Set(saved.editorOpenDirs) })
        } else if (saved.editorOpenSessionIds && saved.editorOpenSessionIds.length > 0) {
          // Backwards compat: map old per-tab indices to directories
          const openIndexSet = new Set(saved.editorOpenSessionIds)
          const dirs = new Set<string>()
          for (const r of restoredTabIds) {
            if (openIndexSet.has(r.index)) {
              const st = saved.tabs[r.index]
              if (st?.workingDirectory) dirs.add(st.workingDirectory)
            }
          }
          if (dirs.size > 0) {
            useSessionStore.setState({ fileEditorOpenDirs: dirs })
          }
        }

        // Restore global editor geometry (clamped to current screen)
        if (saved.editorGeometry) {
          const g = saved.editorGeometry
          const clampedGeo = {
            x: Math.max(-200, Math.min(window.innerWidth - 100, g.x)),
            y: Math.max(0, Math.min(window.innerHeight - 32, g.y)),
            w: Math.max(400, g.w),
            h: Math.max(280, g.h),
          }
          useSessionStore.setState({ editorGeometry: clampedGeo })
        }

        // Restore global plan preview geometry (clamped to current screen)
        if (saved.planGeometry) {
          const g = saved.planGeometry
          const clampedGeo = {
            x: Math.max(-200, Math.min(window.innerWidth - 100, g.x)),
            y: Math.max(0, Math.min(window.innerHeight - 32, g.y)),
            w: Math.max(280, g.w),
            h: Math.max(180, g.h),
          }
          useSessionStore.setState({ planGeometry: clampedGeo })
        }

        // Restore expanded/collapsed state, or fall back to setting
        const restoredExpanded = typeof saved.isExpanded === 'boolean'
          ? saved.isExpanded
          : useThemeStore.getState().expandOnTabSwitch
        useSessionStore.setState({ isExpanded: restoredExpanded, tabsReady: true })
        return
      }

      // No saved tabs -- fall through to blank tab behavior
      const tab = useSessionStore.getState().tabs[0]
      if (tab) {
        const defaultBase = useThemeStore.getState().defaultBaseDirectory
        const startDir = defaultBase || homeDir
        const hasChosen = !!defaultBase
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, workingDirectory: startDir, hasChosenDirectory: hasChosen } : t)),
        }))
        const registerInitialTab = async (retries = 5): Promise<void> => {
          for (let i = 0; i < retries; i++) {
            try {
              const { tabId } = await window.coda.createTab()
              useSessionStore.setState((s) => ({
                tabs: s.tabs.map((t, idx) => (idx === 0 ? { ...t, id: tabId } : t)),
                activeTabId: tabId,
                tabsReady: true,
              }))
              return
            } catch {
              if (i < retries - 1) await new Promise((r) => setTimeout(r, 500))
            }
          }
          // All retries failed — still set tabsReady so UI isn't stuck forever
          useSessionStore.setState({ tabsReady: true })
        }
        registerInitialTab()
      }
    })
  }, [])

  // OS-level click-through (RAF-throttled to avoid per-pixel IPC)
  useEffect(() => {
    if (!window.coda?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null

    const onMouseMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isUI = !!(el && el.closest('[data-coda-ui]'))
      const shouldIgnore = !isUI
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        if (shouldIgnore) {
          window.coda.setIgnoreMouseEvents(true, { forward: true })
        } else {
          window.coda.setIgnoreMouseEvents(false)
        }
      }
    }

    const onMouseLeave = () => {
      if (lastIgnored !== true) {
        lastIgnored = true
        window.coda.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  // ─── Keyboard shortcuts ───
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === '1') {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleFileExplorer(id)
      }
      if (e.metaKey && e.key === 'e') {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleFileEditor(id)
      }
      if (e.metaKey && e.key === '2') {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleTerminal(id)
      }
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        if (e.shiftKey) {
          // Ctrl+Shift+`: add a new shell instance in the current tab
          const s = useSessionStore.getState()
          const id = s.activeTabId
          const tab = s.tabs.find((t) => t.id === id)
          if (tab) {
            if (!s.terminalOpenTabIds.has(id)) s.toggleTerminal(id)
            s.addTerminalInstance(id, 'user', tab.workingDirectory)
          }
        } else {
          // Ctrl+`: toggle terminal
          const id = useSessionStore.getState().activeTabId
          useSessionStore.getState().toggleTerminal(id)
        }
      }
      if (e.metaKey && e.key === '3') {
        e.preventDefault()
        useSessionStore.getState().toggleGitPanel()
      }
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault()
        const s = useSessionStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        const current = tab?.permissionMode ?? 'plan'
        s.setPermissionMode(current === 'plan' ? 'auto' : 'plan')
      }
      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        const s = useSessionStore.getState()
        if (!s.isExpanded) s.toggleExpanded()
      }
      if (e.metaKey && e.key === 'j') {
        e.preventDefault()
        const s = useSessionStore.getState()
        if (s.isExpanded) s.toggleExpanded()
      }
      if (e.metaKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        useThemeStore.getState().zoomIn()
      }
      if (e.metaKey && e.key === '-') {
        e.preventDefault()
        useThemeStore.getState().zoomOut()
      }
      if (e.metaKey && e.key === '0') {
        e.preventDefault()
        useThemeStore.getState().setUiZoom(1)
      }
      if (e.metaKey && e.key === 'h') {
        e.preventDefault()
        const { tabs, activeTabId, selectTab } = useSessionStore.getState()
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length]
        if (prev) selectTab(prev.id)
      }
      if (e.metaKey && e.key === 'l') {
        e.preventDefault()
        const { tabs, activeTabId, selectTab } = useSessionStore.getState()
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const next = tabs[(idx + 1) % tabs.length]
        if (next) selectTab(next.id)
      }
      if (e.metaKey && e.key === 'w') {
        e.preventDefault()
        const { tabs, activeTabId } = useSessionStore.getState()
        const tab = tabs.find((t) => t.id === activeTabId)
        if (tab) {
          setCloseConfirmTab({
            id: tab.id,
            title: tab.customTitle || tab.title || 'Untitled',
            directory: tab.workingDirectory,
          })
        }
      }
      if (e.metaKey && !e.shiftKey && e.key === 'n') {
        e.preventDefault()
        const s = useSessionStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (!tab) return
        const dir = editorDirForTab(tab)
        if (!s.fileEditorOpenDirs.has(dir)) {
          // Open the editor panel (without creating a default file — we'll create one below)
          useSessionStore.setState({ fileEditorOpenDirs: new Set([...s.fileEditorOpenDirs, dir]), fileEditorFocused: true })
        }
        s.createScratchFile(dir)
      }
      if (e.metaKey && e.shiftKey && e.key === 't') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('coda:close-group-pickers'))
        const s = useSessionStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab?.workingDirectory) {
          s.createTabInDirectory(tab.workingDirectory)
        } else {
          s.createTab()
        }
      }
      if (e.metaKey && !e.shiftKey && e.key === 't') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('coda:close-group-pickers'))
        useSessionStore.getState().createTab()
      }
      if (e.metaKey && e.key === 'r') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('coda:open-recent-dirs'))
      }
      if (e.metaKey && e.key === 'y') {
        e.preventDefault()
        const s = useSessionStore.getState()
        const id = s.activeTabId
        if (s.terminalTallTabId === id) {
          s.toggleTerminalTall(id)
        } else if (s.tallViewTabId === id) {
          s.toggleTallView(id)
        } else {
          const inTerminal = !!document.activeElement?.closest('.xterm')
          if (inTerminal && s.terminalOpenTabIds.has(id)) {
            s.toggleTerminalTall(id)
          } else {
            s.toggleTallView(id)
          }
        }
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        const s = useSessionStore.getState()
        if (s.settingsOpen) s.closeSettings()
        else s.openSettings()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const isExpanded = useSessionStore((s) => s.isExpanded)
  const isTallView = useSessionStore((s) => s.tallViewTabId === s.activeTabId)
  const isTerminalTall = useSessionStore((s) => s.terminalTallTabId === s.activeTabId)
  const isTerminalBigScreen = useSessionStore((s) => s.terminalBigScreenTabId === s.activeTabId)
  const marketplaceOpen = useSessionStore((s) => s.marketplaceOpen)
  const gitPanelOpen = useSessionStore((s) => s.gitPanelOpen)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const isTerminalOnly = activeTab?.isTerminalOnly || false
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

  // Dynamic window height for tall view
  const [winHeight, setWinHeight] = useState(window.innerHeight)
  useEffect(() => {
    const onResize = () => setWinHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // In tall view: fill available vertical space (minus tab strip, status bar, input bar, margins)
  const bodyMaxHeight = isTallView ? winHeight - 200 : bodyMaxHeightNormal

  const handleMainUIMouseDown = useCallback(() => {
    if (useSessionStore.getState().fileEditorFocused) {
      useSessionStore.getState().blurFileEditor()
    }
  }, [])

  const handleScreenshot = useCallback(async () => {
    const result = await window.coda.takeScreenshot()
    if (!result) return
    addAttachments([result])
  }, [addAttachments])

  const handleAttachFile = useCallback(async () => {
    const files = await window.coda.attachFiles()
    if (!files || files.length === 0) return
    addAttachments(files)
  }, [addAttachments])

  return (
    <PopoverLayerProvider>
      <div className="flex flex-col justify-end h-full" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div onMouseDown={handleMainUIMouseDown} style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)' }}>

          <AnimatePresence initial={false}>
            {marketplaceOpen && (
              <div
                data-coda-ui
                style={{
                  width: 720,
                  maxWidth: 720,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 30,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-coda-ui
                    className="glass-surface overflow-hidden"
                    style={{
                      borderRadius: 24,
                      maxHeight: 470,
                    }}
                  >
                    <MarketplacePanel />
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

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
                data-coda-ui
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={TRANSITION}
                style={{ marginBottom: 10, position: 'relative', zIndex: 20 }}
              >
                <div
                  data-coda-ui
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

          {/*
            ─── Tabs / message shell ───
            This always remains the chat shell. The marketplace is a separate
            panel rendered above it, never inside it.
          */}
          <motion.div
            data-coda-ui
            className="overflow-hidden flex flex-col"
            animate={{
              width: isExpanded || isTerminalOnly || isTerminalTall ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded || isTerminalOnly || isTerminalTall ? 10 : -14,
              marginLeft: isExpanded || isTerminalOnly || isTerminalTall ? 0 : cardCollapsedMargin,
              marginRight: isExpanded || isTerminalOnly || isTerminalTall ? 0 : cardCollapsedMargin,
              background: isExpanded || isTerminalOnly || isTerminalTall ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded || isTerminalOnly || isTerminalTall ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded || isTerminalOnly || isTerminalTall ? 20 : 10,
            }}
          >
            {/* Tab strip — always mounted */}
            <div>
              <TabStrip />
            </div>

            {/* Terminal-only tab: full terminal, no conversation */}
            {isTerminalOnly && !isTerminalBigScreen && activeTab && (
              <div style={{ height: isTerminalTall ? winHeight - 200 : 420 }}>
                <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
              </div>
            )}

            {/* Terminal tall mode: terminal replaces conversation */}
            {!isTerminalOnly && isTerminalTall && !isTerminalBigScreen && terminalOpen && activeTab && (
              <div style={{ height: winHeight - 200 }}>
                <TerminalPanel tabId={activeTabId} cwd={activeTab.workingDirectory} />
              </div>
            )}

            {/* Body — chat history (hidden when terminal-only or terminal-tall) */}
            {!isTerminalOnly && !isTerminalTall && (
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
            {/* StatusBar must always mount so useGitPolling runs for terminal-only/tall tabs */}
            {(isTerminalOnly || isTerminalTall) && (
              <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
                <StatusBar />
              </div>
            )}
          </motion.div>

          {/* ─── Input row — circles float outside left ─── */}
          {/* Hidden when terminal-only tab (no conversation input needed) */}
          {/* marginBottom: shadow buffer so the glass-surface drop shadow isn't clipped at the native window edge */}
          <div data-coda-ui className="relative" style={{ minHeight: isTerminalOnly ? 20 : 46, zIndex: 15, marginBottom: isTerminalOnly ? 20 : 60, pointerEvents: isTerminalOnly ? 'none' : undefined, opacity: isTerminalOnly ? 0 : 1 }}>
            {/* Stacked circle buttons — expand on hover */}
            <div
              data-coda-ui
              className="circles-out"
            >
              <div className={`btn-stack${quickTools.length > 0 ? ' has-4' : ''}`}>
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
                {/* btn-3: Skills (back, leftmost) */}
                <button
                  className="stack-btn stack-btn-3 glass-surface"
                  title="Skills & Plugins"
                  onClick={() => useSessionStore.getState().toggleMarketplace()}
                  disabled={isRunning}
                >
                  <HeadCircuit size={17} />
                </button>
                {/* btn-4: Quick Tools (backmost) */}
                {quickTools.length > 0 && (
                  <button
                    ref={quickToolsBtnRef}
                    className="stack-btn stack-btn-4 glass-surface"
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
              data-coda-ui
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
                data-coda-ui
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
                data-coda-ui
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
