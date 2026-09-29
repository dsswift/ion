import { useSessionStore, editorDirForTab } from '@ion/server/store/sessionStore'
import { usePreferencesStore } from '../preferences'
import { SETTINGS_DEFAULTS } from '@ion/server/preferences-types'
import { rDebug } from '../rendererLogger'

/**
 * Flip permission mode in the renderer that owns authoritative active-tab
 * state. In Studio, mirror action forwarding runs the read-plus-write atomically
 * in Overlay, never from a potentially stale mirrored instance.
 */
export function toggleActivePermissionMode(): void {
  rDebug('shortcuts', 'toggling active permission mode')
  useSessionStore.getState().togglePermissionMode('keyboard')
}

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
 * Cmd+= / Cmd+Plus: grow whichever zoom target owns the shortcut right now
 * (preview pop-up, file editor, else the conversation's data view).
 */
export function adjustZoom(delta: number): void {
  const preferences = usePreferencesStore.getState()
  if (isPreviewZoomTarget()) {
    preferences.setDataViewFontSize(preferences.dataViewFontSize + delta)
  } else if (isEditorZoomTarget()) {
    preferences.setEditorFontSize(preferences.editorFontSize + delta)
  } else {
    preferences.setDataViewFontSize(preferences.dataViewFontSize + delta)
  }
}

/** Cmd+0: reset whichever zoom target owns the shortcut right now. */
export function resetZoom(): void {
  const preferences = usePreferencesStore.getState()
  if (isPreviewZoomTarget()) {
    preferences.setDataViewFontSize(SETTINGS_DEFAULTS.dataViewFontSize)
  } else if (isEditorZoomTarget()) {
    preferences.setEditorFontSize(SETTINGS_DEFAULTS.editorFontSize)
  } else {
    preferences.setDataViewFontSize(SETTINGS_DEFAULTS.dataViewFontSize)
  }
}

/**
 * Handle a new-conversation shortcut. `forceProfilePicker` bypasses saved
 * Project defaults but never an enterprise lock.
 *
 * Every invocation opens the shared project-first NewConversationPicker. The
 * picker then applies workspace and profile policy in one consistent flow.
 *
 * Extracted so it is independently testable without a DOM or React render
 * environment, and shared between Studio and (formerly) the Overlay.
 *
 * @param dir          Target working directory for the new tab.
 * @param label        Log label ('Cmd+T' or 'Cmd+Shift+T').
 * @param dispatchFn   Dependency-injected event dispatcher (defaults to
 *                     `window.dispatchEvent` so the caller stays clean).
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
