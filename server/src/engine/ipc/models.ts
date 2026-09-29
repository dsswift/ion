/**
 * Model cache — the headless core of the desktop's `ipc/models.ts` handler.
 *
 * `updateCache` and `refreshModelCache` hold no Electron dependency: they
 * read from the engine bridge and write the shared `modelCache` object in
 * `../../state`, which both the server and the desktop's IPC layer read.
 * The one genuinely Electron-bound side effect — telling every
 * `BrowserWindow` the cache changed — is NOT this module's job. The desktop
 * registers a notifier via `setModelCacheUpdateNotifier`; a headless server
 * process with no windows simply leaves it unset (a no-op).
 */
import { engineBridge, modelCache, enterprisePolicyCache } from '../../state'
import { getModelDisplayLabel, getProviderDisplayName } from '@ion/shared/types-models'
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import { log as _log } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

let notifyModelCacheUpdated: () => void = () => {}

/** Registers the window-notification side effect. Desktop-only; a no-op on a headless server. */
export function setModelCacheUpdateNotifier(notifier: () => void): void {
  notifyModelCacheUpdated = notifier
}

/** Update the model cache from a list_models result. */
export function updateCache(result: { models: any[]; providers: any[] }): void {
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
    // Whether the model caches at all, and for how long an entry stays
    // readable. Both are needed to price the "stay on this model" side of a
    // switch honestly: past the lifetime the next turn re-writes the whole
    // prompt at the creation rate, so quoting the read rate there understates
    // the cost by the full creation-to-read ratio.
    supportsCaching: m.supportsCaching,
    cacheTtlSeconds: m.cacheTtlSeconds,
  }))
  modelCache.lastFetched = Date.now()
}

/** Fetch models from engine and update the cache. Notifies any registered window listener. */
export async function refreshModelCache(): Promise<void> {
  try {
    const result = await engineBridge.listModels()
    updateCache(result)
    notifyModelCacheUpdated()
    log('model_cache: refreshed', { count: modelCache.models.length })
  } catch (err) {
    log('model_cache: refresh failed', { error: (err as Error).message })
  }
}
