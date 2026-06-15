import { useEffect } from 'react'
import { useSessionStore, editorDirForTab } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { SETTINGS_DEFAULTS } from '../preferences-types'

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
 * Cmd+= / Cmd+- grow/shrink the focused component's font · Cmd+0 reset it.
 *   Focus in the file editor (CodeMirror) → editor font size; the editor's
 *   own keymap (FileEditorCodeMirror) handles Cmd+= / Cmd+-, so this global
 *   handler defers for those keys. Otherwise → conversation message font
 *   size. Cmd+0 resets the focused component to the shipped default
 *   (SETTINGS_DEFAULTS) for both editor and conversation. These keys no
 *   longer zoom the whole UI; uiZoom remains adjustable from Settings.
 * Cmd+F find in conversation · Cmd+G next match · Cmd+Shift+G prev match
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
        // Editor focus: CodeMirror's own keymap (FileEditorCodeMirror) handles
        // Mod-= and already bumps editorFontSize. Defer to it — do not also act
        // here, or the size would step twice. preventDefault is intentionally
        // skipped so the editor keymap still receives the event.
        if (document.activeElement?.closest('.cm-editor')) return
        e.preventDefault()
        const p = usePreferencesStore.getState()
        p.setConversationFontSize(p.conversationFontSize + 1)
      }
      if (e.metaKey && e.key === '-') {
        if (document.activeElement?.closest('.cm-editor')) return
        e.preventDefault()
        const p = usePreferencesStore.getState()
        p.setConversationFontSize(p.conversationFontSize - 1)
      }
      if (e.metaKey && e.key === '0') {
        // Reset the focused component's font to the shipped default. Unlike
        // Cmd+= / Cmd+-, CodeMirror has no Mod-0 binding, so this global
        // handler resets the editor itself when the editor is focused.
        e.preventDefault()
        const p = usePreferencesStore.getState()
        if (document.activeElement?.closest('.cm-editor')) {
          p.setEditorFontSize(SETTINGS_DEFAULTS.editorFontSize)
        } else {
          p.setConversationFontSize(SETTINGS_DEFAULTS.conversationFontSize)
        }
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
      if (e.metaKey && !e.shiftKey && e.key === 'f') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:open-conversation-search'))
      }
      if (e.metaKey && !e.shiftKey && e.key === 'g') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:search-next'))
      }
      if (e.metaKey && e.shiftKey && e.key === 'g') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:search-prev'))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setCloseConfirmTab])
}
