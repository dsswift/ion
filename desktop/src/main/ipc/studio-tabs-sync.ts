import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { broadcast } from '../broadcast'
import { log } from '../logger'
import { state } from '../state'

let snapshot: unknown = null
let revision = 0

/** Existing owner tab-metadata snapshot, extracted from the Studio IPC module. */
export function registerStudioTabsSyncIpc(): void {
  ipcMain.on(IPC.STUDIO_PUBLISH_TABS_SYNC, (event, candidate: unknown) => {
    const owner = state.mainWindow
    const ownerId = owner && !owner.isDestroyed() ? owner.webContents.id : null
    if (ownerId === null || event.sender.id !== ownerId) {
      log('studio_tabs_sync', 'publish rejected, sender is not owner', {
        sender_id: event.sender.id,
        owner_id: ownerId,
      })
      return
    }
    if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      log('studio_tabs_sync', 'publish rejected, invalid snapshot', {
        sender_id: event.sender.id,
      })
      return
    }

    snapshot = { ...(candidate as Record<string, unknown>), revision: ++revision }
    log('studio_tabs_sync', 'snapshot accepted', { revision })
    broadcast(IPC.STUDIO_TABS_SYNC, snapshot)
  })

  ipcMain.handle(IPC.STUDIO_GET_TABS_SYNC, () => snapshot)
}

export function resetStudioTabsSyncForTests(): void {
  snapshot = null
  revision = 0
}
