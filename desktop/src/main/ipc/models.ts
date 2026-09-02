import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, debug as _debug } from '../logger'
import { engineBridge, modelCache, enterprisePolicyCache } from '../state'
import { broadcast } from '../broadcast'
import { getModelDisplayLabel, getProviderDisplayName } from '../../shared/types-models'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'
import type { ModelTier } from '../../shared/types-model-tiers'

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
    // Resolved here, once, rather than on each client: getProviderDisplayName
    // folds the operator's engine.json `displayName` over the built-in name
    // map. iOS never receives ProviderEntry (it consumes the flattened
    // RemoteModelEntry), so without this projection the phone's picker could
    // only ever show a raw provider id and would silently ignore the
    // operator's configured name.
    providerLabel: getProviderDisplayName(m.providerId, providers),
    label: getModelDisplayLabel(m),
    contextWindow: m.contextWindow,
    // Output cap and the engine's own usable-input limit. Both feed the
    // client-side capacity calculation, which is why they must reach iOS:
    // without them the phone subtracts a generic 20k output reserve from the
    // raw window and reports a different remaining budget than the desktop
    // does for the same conversation.
    maxOutputTokens: m.maxOutputTokens,
    effectiveContextLimit: m.effectiveContextLimit,
    hasAuth: providerAuth.get(m.providerId) ?? false,
    thinkingMode: m.thinkingMode,
    thinkingEfforts: m.thinkingEfforts,
    modelKind: m.modelKind,
    isCustom: m.isCustom,
    // Base input price, projected so a client can price a model switch. iOS
    // never receives the engine's model catalog, so without this field the
    // phone could only warn that a switch is expensive without saying how
    // expensive — and a warning with no number is the kind a user learns to
    // dismiss. The cache-creation and cache-read rates are derived from this
    // one value by the shared multipliers (see shared/model-switch-cost.ts),
    // matching what the engine does when a model carries no explicit cache
    // pricing.
    costPer1kInput: m.costPer1kInput,
    costPer1kCacheCreation: m.costPer1kCacheCreation,
    costPer1kCacheRead: m.costPer1kCacheRead,
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

function isModelTier(value: unknown): value is ModelTier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tier = value as Record<string, unknown>
  return typeof tier.name === 'string' && tier.name.trim() !== ''
    && typeof tier.model === 'string' && tier.model.trim() !== ''
    && Array.isArray(tier.fallbacks) && tier.fallbacks.every((fallback) => typeof fallback === 'string')
}

function isTierNamePayload(value: unknown): value is { name: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).name === 'string'
    && (value as Record<string, string>).name.trim() !== ''
}

export function registerModelsIpc(): void {
  ipcMain.handle(IPC.LIST_MODEL_TIERS, async () => {
    debug('IPC LIST_MODEL_TIERS')
    try {
      return await engineBridge.listModelTiers()
    } catch (err) {
      log('model_tiers: list failed', { error: (err as Error).message })
      throw err
    }
  })

  ipcMain.handle(IPC.SET_MODEL_TIER, async (_e, payload: unknown) => {
    if (!isModelTier(payload)) {
      log('model_tiers: set rejected malformed payload')
      return { ok: false, error: 'set_model_tier requires name, model, and string fallbacks' }
    }
    const tier = payload
    debug('IPC SET_MODEL_TIER', { tier: tier.name, model: tier.model, fallbackCount: tier.fallbacks.length })
    const result = await engineBridge.setModelTier(tier)
    if (!result.ok) log('model_tiers: set failed', { tier: tier.name, error: result.error ?? 'unknown' })
    return result
  })

  ipcMain.handle(IPC.REMOVE_MODEL_TIER, async (_e, payload: unknown) => {
    if (!isTierNamePayload(payload)) {
      log('model_tiers: remove rejected malformed payload')
      return { ok: false, error: 'remove_model_tier requires a tier name' }
    }
    const { name } = payload
    debug('IPC REMOVE_MODEL_TIER', { tier: name })
    const result = await engineBridge.removeModelTier(name)
    if (!result.ok) log('model_tiers: remove failed', { tier: name, error: result.error ?? 'unknown' })
    return result
  })

  ipcMain.handle(IPC.MODEL_TIER_RESOLVE, async (_e, { tier }: { tier: string }) => {
    debug('IPC MODEL_TIER_RESOLVE', { tier })
    try {
      return await engineBridge.resolveModelTier(tier)
    } catch (err) {
      log('model_tier: resolve failed', { tier, error: (err as Error).message })
      // Unreachable engine reads as unconfigured: the gated feature refuses
      // with its remediation message rather than proceeding on a guess.
      return { tier, model: tier, fallbacks: [], configured: false }
    }
  })

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

  engineBridge.on('event', (_key: string, event: { type?: string; modelTiers?: ModelTier[] }) => {
    if (event.type !== 'engine_model_tiers') return
    log('model_tiers: snapshot received', { count: event.modelTiers?.length ?? 0 })
    broadcast(IPC.MODEL_TIERS_UPDATED)
  })

  // Auto-fetch models when engine reconnects
  engineBridge.on('reconnected', () => {
    log('Engine reconnected — refreshing model cache')
    void refreshModelCache()
  })

  // Initial fetch after a short delay to give the engine bridge time to connect
  setTimeout(() => { void refreshModelCache() }, 2000)
}
