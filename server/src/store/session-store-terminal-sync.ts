import type { StoreApi } from 'zustand'
import type { State } from './session-store-types'
import { projectStudioConversationTerminals } from '@ion/shared/studio-conversation-terminal-sync'
import { rDebug } from './rendererLogger'
import { studioPublishConversationTerminals } from './host-api'

/** Publish Conversation Terminal Panel metadata from the Overlay owner only. */
export function setupStudioConversationTerminalSync(store: StoreApi<State>): () => void {
  let ready = store.getState().tabsReady
  const publish = (state: State): void => {
    const snapshot = projectStudioConversationTerminals(state.terminalPanes, state.terminalOpenTabIds)
    studioPublishConversationTerminals(snapshot)
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
