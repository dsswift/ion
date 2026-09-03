import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import {
  isStudioConversationTerminalPublish,
  type StudioConversationTerminalSnapshot,
} from '../../shared/studio-conversation-terminal-sync'
import { broadcast } from '../broadcast'
import { log } from '../logger'
import { state } from '../state'

let snapshot: StudioConversationTerminalSnapshot | null = null
let revision = 0

export function registerStudioConversationTerminalSyncIpc(): void {
  ipcMain.on(IPC.STUDIO_PUBLISH_CONVERSATION_TERMINALS, (event, candidate: unknown) => {
    const owner = state.mainWindow
    const ownerId = owner && !owner.isDestroyed() ? owner.webContents.id : null
    log('studio_terminal_sync', 'snapshot publish received', {
      sender_id: event.sender.id,
      owner_id: ownerId,
    })
    if (ownerId === null || event.sender.id !== ownerId) {
      log('studio_terminal_sync', 'snapshot publish rejected, sender is not owner', {
        sender_id: event.sender.id,
        owner_id: ownerId,
      })
      return
    }
    if (!isStudioConversationTerminalPublish(candidate)) {
      log('studio_terminal_sync', 'snapshot publish rejected, invalid payload', {
        sender_id: event.sender.id,
      })
      return
    }

    snapshot = { ...candidate, revision: ++revision }
    const terminalCount = snapshot.panes.reduce((total, pane) => total + pane.instances.length, 0)
    log('studio_terminal_sync', 'snapshot accepted', {
      revision,
      conversation_count: snapshot.panes.length,
      terminal_count: terminalCount,
      open_panel_count: snapshot.openTabIds.length,
    })
    broadcast(IPC.STUDIO_CONVERSATION_TERMINALS, snapshot)
    log('studio_terminal_sync', 'snapshot delivery requested', {
      revision,
      studio_open: !!state.studioWindow && !state.studioWindow.isDestroyed(),
    })
  })

  ipcMain.handle(IPC.STUDIO_GET_CONVERSATION_TERMINALS, () => {
    log('studio_terminal_sync', 'snapshot cache read', {
      revision: snapshot?.revision ?? 0,
      available: snapshot !== null,
    })
    return snapshot
  })
}

export function resetStudioConversationTerminalSyncForTests(): void {
  snapshot = null
  revision = 0
}
