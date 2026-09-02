import { useSessionStore, editorDirForTab } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { SETTINGS_DEFAULTS } from '../preferences-types'
import { rDebug, rError } from '../rendererLogger'
import { toggleActivePermissionMode } from '../shortcuts/shared-command-handlers'
import { useCommandShortcuts } from './useCommandShortcuts'
import { resolveTextZoomTarget } from '../zoom-target'

/**
 * Returns true when the file editor panel owns the font-zoom shortcuts.
 *
 * "Editor owns zoom" when ALL of:
 *   1. fileEditorFocused is true (the user last interacted with the editor panel)
 *   2. The active tab's editor dir is in fileEditorOpenDirs (the panel is visible)
 *   3. The editor dir has an active file in fileEditorStates (something is open)
 *
 * This is evaluated from durable store state, not from transient DOM focus, so
 * it survives CodeMirror re-renders on font-size change and works in preview
 * mode where no .cm-editor DOM node exists.
 */
export function isEditorZoomTarget(): boolean {
  const s = useSessionStore.getState()
  if (!s.fileEditorFocused) return false
  const activeTab = s.tabs.find((t) => t.id === s.activeTabId)
  if (!activeTab) return false
  const dir = editorDirForTab(activeTab)
  if (!s.fileEditorOpenDirs.has(dir)) return false
  const dirState = s.fileEditorStates.get(dir)
  return !!(dirState && dirState.activeFileId)
}

/**
 * Returns true when a floating pop-up (FloatingPanel) is currently mounted.
 * A pop-up is the zoom target when it's open and visible, taking precedence
 * over the editor and conversation.
 *
 * Uses durable store state (openFloatingPanelCount), not transient DOM focus,
 * matching the same discipline as isEditorZoomTarget(). Survives font-size-
 * change re-renders that might blur the pop-up's DOM element.
 */
export function isPreviewZoomTarget(): boolean {
  return useSessionStore.getState().openFloatingPanelCount > 0
}

/**
 * Handle a new-conversation shortcut. `forceProfilePicker` bypasses saved
 * Project defaults but never an enterprise lock.
 *
 * Every invocation opens the shared project-first NewConversationPicker. The
 * picker then applies workspace and profile policy in one consistent flow.
 *
 * Extracted from the keydown handler to make it independently testable
 * without a DOM or React render environment.
 *
 * @param dir          Target working directory for the new tab.
 * @param label        Log label ('Cmd+T' or 'Cmd+Shift+T').
 * @param dispatchFn   Dependency-injected event dispatcher (defaults to
 *                     `window.dispatchEvent` so the hook path stays clean).
 */
export function handleNewConversationShortcut(
  dir: string,
  label: string,
  dispatchFn: (e: Event) => void = (e) => window.dispatchEvent(e),
  forceProfilePicker = false,
): void {
  const s = useSessionStore.getState()
  rDebug('shortcuts', 'opening unified new conversation picker', { label, suggested_dir: dir, force_profile_picker: forceProfilePicker, active_tab_id: s.activeTabId ? s.activeTabId.slice(0, 8) : '' })
  dispatchFn(new CustomEvent('ion:open-new-conversation-picker', { detail: forceProfilePicker ? { forceProfilePicker: true } : null }))
}

/**
 * Overlay command registry. `useCommandShortcuts` is sole global key listener:
 * command IDs, persisted bindings, conflict behavior, and logging are shared
 * with Studio. The Overlay contributes only its view-specific action bodies.
 */
export function useKeyboardShortcuts(togglePalette: () => void = () => {}): void {
  useCommandShortcuts({
    view: 'overlay',
    handlers: {
      'panel.inbox': () => useSessionStore.getState().toggleInboxPanel(),
      'panel.explorer': () => {
        const state = useSessionStore.getState()
        state.toggleFileExplorer(state.activeTabId)
      },
      'panel.editor': () => {
        const state = useSessionStore.getState()
        state.toggleFileEditor(state.activeTabId)
      },
      'panel.terminal': () => {
        const state = useSessionStore.getState()
        void state.toggleTerminal(state.activeTabId).catch((error) => {
          rError('shortcut', 'conversation terminal panel toggle failed', {
            tab_id: state.activeTabId,
            error: String(error),
          })
        })
      },
      'terminal.addShell': () => {
        const state = useSessionStore.getState()
        const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
        if (!tab) return
        void state.addTerminalInstance(state.activeTabId, 'user', tab.workingDirectory).catch((error) => {
          rError('shortcut', 'conversation terminal creation failed', {
            tab_id: state.activeTabId,
            cwd: tab.workingDirectory,
            error: String(error),
          })
        })
      },
      'terminal.toggle': () => {
        const state = useSessionStore.getState()
        void state.toggleTerminal(state.activeTabId).catch((error) => {
          rError('shortcut', 'conversation terminal panel toggle failed', {
            tab_id: state.activeTabId,
            error: String(error),
          })
        })
      },
      'panel.git': () => useSessionStore.getState().toggleGitPanel(),
      'panel.statusDrawer': () => useSessionStore.getState().toggleStatusDrawer(),
      'permission.togglePlanAuto': toggleActivePermissionMode,
      'layout.collapse': () => {
        const state = useSessionStore.getState()
        if (state.isExpanded) state.toggleExpanded()
      },
      'zoom.in': () => adjustZoom(1),
      'zoom.inShifted': () => adjustZoom(1),
      'zoom.out': () => adjustZoom(-1),
      'zoom.reset': resetZoom,
      'tab.prev': () => stepConversation(-1),
      'tab.next': () => stepConversation(1),
      'tab.close': () => {
        const { activeTabId, requestCloseTab } = useSessionStore.getState()
        if (!activeTabId) return
        void requestCloseTab(activeTabId).catch((error) => rError('shortcuts', 'requestCloseTab failed', {
          tab_id: activeTabId.slice(0, 8), error: String(error),
        }))
      },
      'tab.scratch': () => {
        const state = useSessionStore.getState()
        const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
        if (!tab) return
        const dir = editorDirForTab(tab)
        if (!state.fileEditorOpenDirs.has(dir)) {
          useSessionStore.setState({
            fileEditorOpenDirs: new Set([...state.fileEditorOpenDirs, dir]),
            fileEditorFocused: true,
          })
        }
        state.createScratchFile(dir)
      },
      'tab.newHere': () => {
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
        const state = useSessionStore.getState()
        const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
        handleNewConversationShortcut(tab?.workingDirectory || '', 'Cmd+Shift+T')
      },
      'tab.new': () => {
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
        handleNewConversationShortcut('', 'Cmd+T')
      },
      'tab.newPicker': () => {
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
        handleNewConversationShortcut('', 'Cmd+Opt+T', undefined, true)
      },
      'tab.recentDirs': () => { window.dispatchEvent(new CustomEvent('ion:open-recent-dirs')) },
      'layout.tall': toggleTallView,
      'app.commandPalette': togglePalette,
      'settings.open': () => {
        const state = useSessionStore.getState()
        if (state.settingsOpen) state.closeSettings()
        else state.openSettings()
      },
      'conversation.find': () => { window.dispatchEvent(new CustomEvent('ion:open-conversation-search')) },
      'conversation.findNext': () => { window.dispatchEvent(new CustomEvent('ion:search-next')) },
      'conversation.findPrev': () => { window.dispatchEvent(new CustomEvent('ion:search-prev')) },
    },
  })
}

function activeTextZoomTarget(): ReturnType<typeof resolveTextZoomTarget> {
  const state = useSessionStore.getState()
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  const dir = activeTab ? editorDirForTab(activeTab) : ''
  const editorState = dir ? state.fileEditorStates.get(dir) : undefined
  return resolveTextZoomTarget({
    terminalFocused: !!document.activeElement?.closest('.xterm'),
    editorFocused: state.fileEditorFocused,
    editorOpen: !!editorState?.activeFileId && state.fileEditorOpenDirs.has(dir),
    editorPreview: !!editorState?.files.find((file) => file.id === editorState.activeFileId)?.isPreview,
  })
}

function adjustZoom(delta: number): void {
  const preferences = usePreferencesStore.getState()
  switch (activeTextZoomTarget()) {
    case 'editor':
      preferences.setEditorFontSize(preferences.editorFontSize + delta)
      return
    case 'terminal':
      preferences.setTerminalFontSize(preferences.terminalFontSize + delta)
      return
    case 'data':
      preferences.setDataViewFontSize(preferences.dataViewFontSize + delta)
  }
}

function resetZoom(): void {
  const preferences = usePreferencesStore.getState()
  switch (activeTextZoomTarget()) {
    case 'editor':
      preferences.setEditorFontSize(SETTINGS_DEFAULTS.editorFontSize)
      return
    case 'terminal':
      preferences.setTerminalFontSize(SETTINGS_DEFAULTS.terminalFontSize)
      return
    case 'data':
      preferences.setDataViewFontSize(SETTINGS_DEFAULTS.dataViewFontSize)
  }
}

function stepConversation(delta: number): void {
  const state = useSessionStore.getState()
  if (state.tabs.length === 0) return
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
  const next = state.tabs[(index + delta + state.tabs.length) % state.tabs.length]
  if (next) state.selectTab(next.id)
}

function toggleTallView(): void {
  const state = useSessionStore.getState()
  const id = state.activeTabId
  if (state.terminalTallTabId === id) state.toggleTerminalTall(id)
  else if (state.tallViewTabId === id) state.toggleTallView(id)
  else if (document.activeElement?.closest('.xterm') && state.terminalOpenTabIds.has(id)) state.toggleTerminalTall(id)
  else state.toggleTallView(id)
}
