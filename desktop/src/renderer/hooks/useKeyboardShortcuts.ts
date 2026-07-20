import { useEffect } from 'react'
import { useSessionStore, editorDirForTab } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { SETTINGS_DEFAULTS } from '../preferences-types'
import { resolveNewConversationAction, executeNewConversationAction } from '../components/new-conversation-routing'
import { tabHasExtensions } from '../../shared/tab-predicates'
import { effectivePermissionMode } from '../stores/conversation-instance'
import { resolveBindings } from '../shortcuts/shortcut-catalog'
import { matchesChord } from '../shortcuts/chord'
import { rTrace, rDebug, rError } from '../rendererLogger'

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
 * Handle a Cmd+T / Cmd+Shift+T keystroke.
 *
 * Resolves the new-conversation routing action from the current preference
 * state and either creates a tab directly ('plain', 'profile', 'locked') or
 * — when the action is 'show-picker' — dispatches
 * `ion:open-new-conversation-picker` with the target directory so TabStrip
 * can open the NewConversationPicker anchored to its + button.
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
): void {
  const s = useSessionStore.getState()
  const { engineProfiles, defaultEngineProfileId, enterpriseNewConversationDefaults: policy } = usePreferencesStore.getState()
  const action = resolveNewConversationAction(engineProfiles, defaultEngineProfileId, policy)
  rDebug('shortcuts', 'resolvedAction', { label, action_kind: action.kind, dir, active_tab_id: s.activeTabId ? s.activeTabId.slice(0, 8) : '' })
  try {
    const result = executeNewConversationAction(
      dir,
      action,
      (d) => {
        rDebug('shortcuts', 'createTabInDirectory', { label, dir: d })
        void s.createTabInDirectory(d).catch((err) => rError('shortcuts', 'createTabInDirectory failed', { label, dir: d, error: String(err) }))
      },
      (d, opts) => {
        rDebug('shortcuts', 'createConversationTab', { label, dir: d, profile_id: opts?.profileId ?? '' })
        void s.createConversationTab(d, opts).catch((err) => rError('shortcuts', 'createConversationTab failed', { label, dir: d, error: String(err) }))
      },
    )
    if (result === 'show-picker') {
      rDebug('shortcuts', 'show-picker', { label, dir })
      dispatchFn(new CustomEvent('ion:open-new-conversation-picker', { detail: { dir } }))
    }
  } catch (err) {
    rError('shortcuts', 'executeNewConversationAction threw', { label, action_kind: action.kind, dir, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

interface CloseConfirmTab {
  id: string
  title: string
  directory: string
}

/**
 * Global keyboard shortcuts. Mounted once at the App root.
 *
 * Every shortcut is catalog-driven: the keydown handler reads the resolved
 * binding Map (defaults ⊕ user overrides from settings.json) and uses
 * matchesChord() instead of hardcoded `e.metaKey && e.key === 'x'` checks.
 * This makes user overrides actually control behavior — not just a display
 * list. See `shortcuts/shortcut-catalog.ts` for the catalog and
 * `shortcuts/chord.ts` for the chord DSL.
 *
 * Shortcut groups:
 *   Navigation: tab.prev (Cmd+H) · tab.next (Cmd+L) · tab.close (Cmd+W)
 *   Panels: panel.explorer (Cmd+1) · panel.terminal (Cmd+2) · panel.git (Cmd+3) ·
 *           panel.editor (Cmd+E) · terminal.toggle (Ctrl+`) · terminal.addShell (Ctrl+Shift+`)
 *   Layout: layout.collapse (Cmd+J) · layout.expand (Cmd+K) · layout.tall (Cmd+Y)
 *   Tabs: tab.new (Cmd+T) · tab.newHere (Cmd+Shift+T) · tab.recentDirs (Cmd+R) ·
 *         tab.scratch (Cmd+N)
 *   Zoom: zoom.in (Cmd+=) · zoom.out (Cmd+-) · zoom.reset (Cmd+0)
 *     Zoom routing precedence (durable store state, not DOM focus):
 *       1. isPreviewZoomTarget() → previewFontSize  (a pop-up is open)
 *       2. isEditorZoomTarget()  → editorFontSize   (file editor is active)
 *       3. else                  → conversationFontSize
 *     Cmd+0 resets the active target to SETTINGS_DEFAULTS.
 *   Conversation: conversation.find (Cmd+F) · conversation.findNext (Cmd+G) ·
 *                 conversation.findPrev (Cmd+Shift+G) · permission.togglePlanAuto (Shift+Tab)
 *   App: settings.open (Cmd+,)
 *
 * The Cmd+W flow asks the host App to render a confirmation dialog by
 * invoking `setCloseConfirmTab` with the active tab metadata.
 *
 * Conflict resolution: when two commands resolve to the same chord (possible
 * via user overrides), the first-in-catalog-order command wins and a warning
 * is logged. See resolveBindings() in shortcut-catalog.ts.
 */
export function useKeyboardShortcuts(setCloseConfirmTab: (t: CloseConfirmTab | null) => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Resolve bindings fresh on each event so override changes take effect
      // immediately without remounting the hook.
      const { keyboardShortcuts } = usePreferencesStore.getState()
      const bindings = resolveBindings(keyboardShortcuts)

      // Per-keystroke trace for every Cmd- or Ctrl-modified key. Gated to
      // debug level — verbose but useful for regression forensics.
      if (e.metaKey || e.ctrlKey) {
        const ae = document.activeElement
        const activeTabId = useSessionStore.getState().activeTabId
        const activeTab = useSessionStore.getState().tabs.find((t) => t.id === activeTabId)
        rTrace('shortcuts', 'keydown', { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, default_prevented: e.defaultPrevented, active_el: ae?.tagName ?? '', in_cm_editor: !!(ae?.closest('.cm-editor')), in_xterm: !!(ae?.closest('.xterm')), active_tab_id: activeTabId ? activeTabId.slice(0, 8) : '', tab_has_extensions: activeTab ? tabHasExtensions(activeTab) : false })
      }

      // — Navigation ——————————————————————————————————————————————————

      if (matchesChord(e, bindings.get('panel.explorer') ?? null)) {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleFileExplorer(id)
      }
      if (matchesChord(e, bindings.get('panel.editor') ?? null)) {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleFileEditor(id)
      }
      if (matchesChord(e, bindings.get('panel.terminal') ?? null)) {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleTerminal(id)
      }
      if (matchesChord(e, bindings.get('terminal.addShell') ?? null)) {
        e.preventDefault()
        const s = useSessionStore.getState()
        const id = s.activeTabId
        const tab = s.tabs.find((t) => t.id === id)
        if (tab) {
          if (!s.terminalOpenTabIds.has(id)) s.toggleTerminal(id)
          s.addTerminalInstance(id, 'user', tab.workingDirectory)
        }
      } else if (matchesChord(e, bindings.get('terminal.toggle') ?? null)) {
        e.preventDefault()
        const id = useSessionStore.getState().activeTabId
        useSessionStore.getState().toggleTerminal(id)
      }
      if (matchesChord(e, bindings.get('panel.git') ?? null)) {
        e.preventDefault()
        useSessionStore.getState().toggleGitPanel()
      }

      // — Layout ————————————————————————————————————————————————————

      if (matchesChord(e, bindings.get('permission.togglePlanAuto') ?? null)) {
        e.preventDefault()
        const s = useSessionStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        const current = tab ? effectivePermissionMode(tab, s.conversationPanes) : 'plan'
        s.setPermissionMode(current === 'plan' ? 'auto' : 'plan', 'keyboard')
      }
      if (matchesChord(e, bindings.get('layout.expand') ?? null)) {
        e.preventDefault()
        const s = useSessionStore.getState()
        if (!s.isExpanded) s.toggleExpanded()
      }
      if (matchesChord(e, bindings.get('layout.collapse') ?? null)) {
        e.preventDefault()
        const s = useSessionStore.getState()
        if (s.isExpanded) s.toggleExpanded()
      }

      // — Zoom ——————————————————————————————————————————————————————
      // Route to preview, then editor, then conversation based on durable
      // store state. isPreviewZoomTarget() and isEditorZoomTarget() both
      // survive re-renders caused by the font-size change itself.
      //
      // zoom.in  (Cmd+=) and zoom.inShifted (Cmd++) are both catalog entries
      // so user overrides cover both aliases. zoom.inShifted uses shiftOptional
      // in chord.ts so matchesChord accepts the Shift+= event (e.key='+') even
      // though the chord string doesn't carry an explicit Shift modifier.

      // Shared zoom-in body — called by both zoom.in and zoom.inShifted.
      const doZoomIn = () => {
        const p = usePreferencesStore.getState()
        if (isPreviewZoomTarget()) {
          const prev = p.previewFontSize
          p.setPreviewFontSize(prev + 1)
          rTrace('shortcuts', 'zoom.in: previewFontSize', { from: prev, to: prev + 1 })
        } else if (isEditorZoomTarget()) {
          const prev = p.editorFontSize
          p.setEditorFontSize(prev + 1)
          rTrace('shortcuts', 'zoom.in: editorFontSize', { from: prev, to: prev + 1 })
        } else {
          const prev = p.conversationFontSize
          p.setConversationFontSize(prev + 1)
          rTrace('shortcuts', 'zoom.in: conversationFontSize', { from: prev, to: prev + 1 })
        }
      }

      if (matchesChord(e, bindings.get('zoom.in') ?? null)) {
        e.preventDefault()
        doZoomIn()
      }
      if (matchesChord(e, bindings.get('zoom.inShifted') ?? null)) {
        e.preventDefault()
        doZoomIn()
      }

      if (matchesChord(e, bindings.get('zoom.out') ?? null)) {
        e.preventDefault()
        const p = usePreferencesStore.getState()
        if (isPreviewZoomTarget()) {
          const prev = p.previewFontSize
          p.setPreviewFontSize(prev - 1)
          rTrace('shortcuts', 'zoom.out: previewFontSize', { from: prev, to: prev - 1 })
        } else if (isEditorZoomTarget()) {
          const prev = p.editorFontSize
          p.setEditorFontSize(prev - 1)
          rTrace('shortcuts', 'zoom.out: editorFontSize', { from: prev, to: prev - 1 })
        } else {
          const prev = p.conversationFontSize
          p.setConversationFontSize(prev - 1)
          rTrace('shortcuts', 'zoom.out: conversationFontSize', { from: prev, to: prev - 1 })
        }
      }

      if (matchesChord(e, bindings.get('zoom.reset') ?? null)) {
        // Reset the active zoom target's font to the shipped default.
        e.preventDefault()
        const p = usePreferencesStore.getState()
        if (isPreviewZoomTarget()) {
          const prev = p.previewFontSize
          p.setPreviewFontSize(SETTINGS_DEFAULTS.previewFontSize)
          rTrace('shortcuts', 'zoom.reset: previewFontSize', { from: prev, to: SETTINGS_DEFAULTS.previewFontSize })
        } else if (isEditorZoomTarget()) {
          const prev = p.editorFontSize
          p.setEditorFontSize(SETTINGS_DEFAULTS.editorFontSize)
          rTrace('shortcuts', 'zoom.reset: editorFontSize', { from: prev, to: SETTINGS_DEFAULTS.editorFontSize })
        } else {
          const prev = p.conversationFontSize
          p.setConversationFontSize(SETTINGS_DEFAULTS.conversationFontSize)
          rTrace('shortcuts', 'zoom.reset: conversationFontSize', { from: prev, to: SETTINGS_DEFAULTS.conversationFontSize })
        }
      }

      // — Navigation (tabs) ————————————————————————————————————————

      if (matchesChord(e, bindings.get('tab.prev') ?? null)) {
        e.preventDefault()
        const { tabs, activeTabId, selectTab } = useSessionStore.getState()
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length]
        if (prev) selectTab(prev.id)
      }
      if (matchesChord(e, bindings.get('tab.next') ?? null)) {
        e.preventDefault()
        const { tabs, activeTabId, selectTab } = useSessionStore.getState()
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const next = tabs[(idx + 1) % tabs.length]
        if (next) selectTab(next.id)
      }
      if (matchesChord(e, bindings.get('tab.close') ?? null)) {
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
      if (matchesChord(e, bindings.get('tab.scratch') ?? null)) {
        e.preventDefault()
        const s = useSessionStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (!tab) return
        const dir = editorDirForTab(tab)
        if (!s.fileEditorOpenDirs.has(dir)) {
          useSessionStore.setState({ fileEditorOpenDirs: new Set([...s.fileEditorOpenDirs, dir]), fileEditorFocused: true })
        }
        s.createScratchFile(dir)
      }
      if (matchesChord(e, bindings.get('tab.newHere') ?? null)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
        const s = useSessionStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        const dir = tab?.workingDirectory || usePreferencesStore.getState().defaultBaseDirectory || ''
        handleNewConversationShortcut(dir, 'Cmd+Shift+T')
      } else if (matchesChord(e, bindings.get('tab.new') ?? null)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:close-group-pickers'))
        const dir = usePreferencesStore.getState().defaultBaseDirectory || ''
        handleNewConversationShortcut(dir, 'Cmd+T')
      }
      if (matchesChord(e, bindings.get('tab.recentDirs') ?? null)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:open-recent-dirs'))
      }

      // — Layout tall ——————————————————————————————————————————————

      if (matchesChord(e, bindings.get('layout.tall') ?? null)) {
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

      // — App ———————————————————————————————————————————————————————

      if (matchesChord(e, bindings.get('settings.open') ?? null)) {
        e.preventDefault()
        const s = useSessionStore.getState()
        if (s.settingsOpen) s.closeSettings()
        else s.openSettings()
      }

      // — Conversation search ————————————————————————————————————————

      if (matchesChord(e, bindings.get('conversation.find') ?? null)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:open-conversation-search'))
      }
      if (matchesChord(e, bindings.get('conversation.findNext') ?? null)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:search-next'))
      }
      if (matchesChord(e, bindings.get('conversation.findPrev') ?? null)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ion:search-prev'))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setCloseConfirmTab])
}
