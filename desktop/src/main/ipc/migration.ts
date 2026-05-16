import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { loadOtherBackendTabs, migrateTabsToBackend } from '../tab-migration'
import { getCurrentBackend } from '../settings-store'

export function registerMigrationIpc(): void {
  ipcMain.handle(IPC.LOAD_OTHER_BACKEND_TABS, () => {
    return loadOtherBackendTabs()
  })

  ipcMain.handle(IPC.MIGRATE_TABS, async (_event, { conversationIds, targetBackend }: { conversationIds: string[]; targetBackend: 'api' | 'cli' }) => {
    const current = getCurrentBackend()
    const effectiveTarget = targetBackend || (current === 'api' ? 'cli' : 'api')
    return migrateTabsToBackend(conversationIds, effectiveTarget)
  })
}
