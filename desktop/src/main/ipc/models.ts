import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { engineBridge, modelCache } from '../state'
import { getModelDisplayLabel } from '../../shared/types-models'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'

function log(msg: string): void {
  _log('main', msg)
}

export function registerModelsIpc(): void {
  ipcMain.handle(IPC.LIST_MODELS, async () => {
    log('IPC LIST_MODELS')
    const result = await engineBridge.listModels()
    // Cache for remote snapshots
    try {
      const providers: ProviderEntry[] = result.providers || []
      const models: ModelEntry[] = result.models || []
      const providerAuth = new Map(providers.map((p) => [p.id, p.hasAuth]))
      modelCache.models = models.map((m) => ({
        id: m.id,
        providerId: m.providerId,
        label: getModelDisplayLabel(m),
        contextWindow: m.contextWindow,
        hasAuth: providerAuth.get(m.providerId) ?? false,
      }))
      modelCache.lastFetched = Date.now()
    } catch (err) {
      log(`modelCache update error: ${(err as Error).message}`)
    }
    return result
  })

  ipcMain.handle(IPC.STORE_CREDENTIAL, async (_event, { provider, credential }: { provider: string; credential: string }) => {
    log(`IPC STORE_CREDENTIAL: provider=${provider}`)
    return engineBridge.storeCredential(provider, credential)
  })
}
