import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'

export function maybeCloseExplorerBeforeExternal(): void {
  if (!usePreferencesStore.getState().hideOnExternalLaunch) return
  const { activeTabId, toggleFileExplorer, fileExplorerOpenDirs, tabs } = useSessionStore.getState()
  const tab = tabs.find((t) => t.id === activeTabId)
  if (!tab) return
  if (fileExplorerOpenDirs.has(tab.workingDirectory)) {
    toggleFileExplorer(activeTabId)
  }
}
