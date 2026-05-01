import { useEffect } from 'react'
import { useSessionStore, editorDirForTab } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'

interface CloseConfirmTab {
  id: string
  title: string
  directory: string
}

/**
 * Global keyboard shortcuts. Mounted once at the App root.
 *
 * Cmd+1 file explorer · Cmd+2 terminal · Cmd+3 git panel · Cmd+E editor
 * Cmd+T new tab · Cmd+Shift+T new tab in current dir · Cmd+W close tab (confirm)
 * Cmd+H/L prev/next tab · Cmd+J/K collapse/expand · Cmd+Y tall toggle
 * Cmd+, settings · Cmd+R recent dirs · Cmd+N scratch file
 * Cmd+= zoom in · Cmd+- zoom out · Cmd+0 reset zoom
 * Shift+Tab toggle plan/auto · Ctrl+` toggle terminal · Ctrl+Shift+` add shell
 *
 * The Cmd+W flow asks the host App to render a confirmation dialog by
 * invoking `setCloseConfirmTab` with the active tab metadata.
 */
export function useKeyboardShortcuts(setCloseConfirmTab: (t: CloseConfirmTab | null) => void) {
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
        s.setPermissionMode(current === 'plan' ? 'auto' : 'plan', 'keyboard')
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
        usePreferencesStore.getState().zoomIn()
      }
      if (e.metaKey && e.key === '-') {
        e.preventDefault()
        usePreferencesStore.getState().zoomOut()
      }
      if (e.metaKey && e.key === '0') {
        e.preventDefault()
        usePreferencesStore.getState().setUiZoom(1)
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
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
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
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
        useSessionStore.getState().createTab()
      }
      if (e.metaKey && e.key === 'r') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:open-recent-dirs'))
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
  }, [setCloseConfirmTab])
}
