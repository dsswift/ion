import type { State } from '../stores/session-store-types'
import { editorDirForTab } from '../stores/sessionStore'

/**
 * Returns a primitive editor directory, never an object wrapper. Zustand compares
 * selector results with Object.is, so an object literal here would report a
 * change on every store notification and can drive React's update-depth guard.
 */
export function selectActiveEditorDir(
  state: Pick<State, 'activeTabId' | 'tabs' | 'fileEditorStates' | 'fileEditorOpenDirs'>,
): string | null {
  const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
  if (!tab) return null
  const dir = editorDirForTab(tab)
  const dirState = state.fileEditorStates.get(dir)
  return dirState && dirState.files.length > 0 && state.fileEditorOpenDirs.has(dir) ? dir : null
}
