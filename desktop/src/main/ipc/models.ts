import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, debug as _debug } from '../logger'
import { engineBridge, modelCache, enterprisePolicyCache } from '../state'
import { getModelDisplayLabel } from '../../shared/types-models'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
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
  let models: ModelEntry[] = result.models || []
  // Enterprise model allowlist (D-011 iOS-parity): the cache feeds the
  // remote snapshot's availableModels projection, so filtering here keeps
  // iOS in policy lockstep with the desktop's own pickers. Engine-side
  // enforcement (dispatch rejection) remains the security boundary.
  const allowedModels = enterprisePolicyCache.policy?.allowedModels
  if (allowedModels && allowedModels.length > 0) {
    const allowed = new Set(allowedModels)
    models = models.filter((m) => allowed.has(m.id))
  }
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
export async function refreshModelCache(): Promise<void> {
  try {
    const result = await engineBridge.listModels()
    updateCache(result)
    notifyRenderers()
    log('model_cache: refreshed', { count: modelCache.models.length })
  } catch (err) {
    log('model_cache: refresh failed', { error: (err as Error).message })
  }
}

export function registerModelsIpc(): void {
  ipcMain.handle(IPC.LIST_MODELS, async () => {
    debug('IPC LIST_MODELS')
    const result = await engineBridge.listModels()
    // Cache for remote snapshots
    try {
      updateCache(result)
    } catch (err) {
      log('model_cache: update error', { error: (err as Error).message })
    }
    return result
  })

  ipcMain.handle(IPC.STORE_CREDENTIAL, async (_event, { provider, credential }: { provider: string; credential: string }) => {
    log('store_credential', { provider })
    const result = await engineBridge.storeCredential(provider, credential)
    if (result.ok) {
      // Auth status changed — engine runs discovery for this provider,
      // then we refresh our cache after a delay to pick up new models.
      setTimeout(() => { void refreshModelCache() }, 2000)
    }
    return result
  })

  ipcMain.handle(IPC.REFRESH_MODELS, async (_event, { provider }: { provider?: string } = {}) => {
    log('refresh_models', { provider: provider || 'all' })
    const result = await engineBridge.refreshModels(provider)
    if (result.ok) {
      // Re-fetch the model list to pick up discovery results
      setTimeout(() => { void refreshModelCache() }, 1000)
    }
    return result
  })

  // Auto-fetch models when engine reconnects
  engineBridge.on('reconnected', () => {
    log('Engine reconnected — refreshing model cache')
    void refreshModelCache()
  })

  // Initial fetch after a short delay to give the engine bridge time to connect
  setTimeout(() => { void refreshModelCache() }, 2000)
}
