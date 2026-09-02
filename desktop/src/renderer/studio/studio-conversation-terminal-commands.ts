import { useSessionStore } from '../stores/sessionStore'
import { rDebug, rWarn } from '../rendererLogger'

/** Add a shell to the active conversation through the owner-forwarded action. */
export function addActiveConversationShell(): void {
  const state = useSessionStore.getState()
  const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
  if (!tab) return

  void state.addTerminalInstance(tab.id, 'user', tab.workingDirectory).then((instanceId) => {
    rDebug('studio.terminal', 'conversation shell added', {
      tab_id: tab.id,
      instance_id: instanceId,
      cwd: tab.workingDirectory,
    })
  }).catch((error) => {
    rWarn('studio.terminal', 'conversation shell add failed', {
      tab_id: tab.id,
      cwd: tab.workingDirectory,
      error: String(error),
    })
  })
}

/** Toggle the active conversation's shared terminal panel. */
export function toggleActiveConversationTerminal(): void {
  const state = useSessionStore.getState()
  const tabId = state.activeTabId
  if (!tabId) return
  const opening = !state.terminalOpenTabIds.has(tabId)

  void state.toggleTerminal(tabId).then(() => {
    rDebug('studio.terminal', 'conversation terminal tray toggled', {
      tab_id: tabId,
      open: opening,
    })
  }).catch((error) => {
    rWarn('studio.terminal', 'conversation terminal tray toggle failed', {
      tab_id: tabId,
      open: opening,
      error: String(error),
    })
  })
}
