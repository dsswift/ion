import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { engineBridge, modelCache } from '../state'
import { getModelDisplayLabel } from '../../shared/types-models'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'

function log(msg: string): void {
  _log('main', msg)
}

/** Notify all renderer windows that the model cache has been updated. */
function notifyRenderers(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ion:models-updated')
  }
}

/** Update the model cache from a list_models result. */
function updateCache(result: { models: any[]; providers: any[] }): void {
  const providers: ProviderEntry[] = result.providers || []
  const models: ModelEntry[] = result.models || []
  const providerAuth = new Map(providers.map((p) => [p.id, p.hasAuth]))
  modelCache.models = models.map((m) => ({
    id: m.id,
    providerId: m.providerId,
    label: getModelDisplayLabel(m),
    contextWindow: m.contextWindow,
    hasAuth: providerAuth.get(m.providerId) ?? false,
    thinkingMode: m.thinkingMode,
    thinkingEfforts: m.thinkingEfforts,
  }))
  modelCache.lastFetched = Date.now()
}

/** Fetch models from engine and update the cache. Notifies renderer windows. */
async function refreshModelCache(): Promise<void> {
  try {
    const result = await engineBridge.listModels()
    updateCache(result)
    notifyRenderers()
    log(`Model cache refreshed: ${modelCache.models.length} models`)
  } catch (err) {
    log(`Model cache refresh failed: ${(err as Error).message}`)
  }
}

export function registerModelsIpc(): void {
  ipcMain.handle(IPC.LIST_MODELS, async () => {
    log('IPC LIST_MODELS')
    const result = await engineBridge.listModels()
    // Cache for remote snapshots
    try {
      updateCache(result)
    } catch (err) {
      log(`modelCache update error: ${(err as Error).message}`)
    }
    return result
  })

  ipcMain.handle(IPC.STORE_CREDENTIAL, async (_event, { provider, credential }: { provider: string; credential: string }) => {
    log(`IPC STORE_CREDENTIAL: provider=${provider}`)
    const result = await engineBridge.storeCredential(provider, credential)
    if (result.ok) {
      // Auth status changed — engine runs discovery for this provider,
      // then we refresh our cache after a delay to pick up new models.
      setTimeout(() => refreshModelCache(), 2000)
    }
    return result
  })

  ipcMain.handle(IPC.REFRESH_MODELS, async (_event, { provider }: { provider?: string } = {}) => {
    log(`IPC REFRESH_MODELS: provider=${provider || 'all'}`)
    const result = await engineBridge.refreshModels(provider)
    if (result.ok) {
      // Re-fetch the model list to pick up discovery results
      setTimeout(() => refreshModelCache(), 1000)
    }
    return result
  })

  // Auto-fetch models when engine reconnects
  engineBridge.on('reconnected', () => {
    log('Engine reconnected — refreshing model cache')
    refreshModelCache()
  })

  // Initial fetch after a short delay to give the engine bridge time to connect
  setTimeout(() => refreshModelCache(), 2000)
}
