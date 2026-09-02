import type { StoreApi } from 'zustand'
import type { State } from './session-store-types'
import { projectStudioConversationTerminals } from '../../shared/studio-conversation-terminal-sync'
import { rDebug, rWarn } from '../rendererLogger'

/** Publish Conversation Terminal Panel metadata from the Overlay owner only. */
export function setupStudioConversationTerminalSync(store: StoreApi<State>): () => void {
  let ready = store.getState().tabsReady
  const publish = (state: State): void => {
    const bridge = window.ion?.studioPublishConversationTerminals
    if (typeof bridge !== 'function') {
      rWarn('studio.terminal-sync', 'owner terminal snapshot bridge unavailable')
      return
    }
    const snapshot = projectStudioConversationTerminals(state.terminalPanes, state.terminalOpenTabIds)
    bridge(snapshot)
    rDebug('studio.terminal-sync', 'owner terminal snapshot published', {
      ready: String(ready),
      conversation_count: snapshot.panes.length,
      terminal_count: snapshot.panes.reduce((total, pane) => total + pane.instances.length, 0),
      open_panel_count: snapshot.openTabIds.length,
    })
  }

  if (ready) publish(store.getState())
  return store.subscribe((state, previous) => {
    if (!ready && state.tabsReady) {
      ready = true
      publish(state)
      return
    }
    if (!ready) return
    if (
      state.terminalPanes !== previous.terminalPanes ||
      state.terminalOpenTabIds !== previous.terminalOpenTabIds
    ) publish(state)
  })
}
