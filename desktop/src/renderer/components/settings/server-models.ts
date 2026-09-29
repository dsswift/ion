/**
 * server-models — the models ONE server offers, grouped by provider, for the
 * model defaults in Settings.
 *
 * A default model is an Account setting: yours on one server, and only a
 * model that server has can be a default there. The list is therefore that
 * server's alone. It used to be the union of every connected server's models,
 * which offered a model from another machine as a default for this one.
 *
 * A model is listed only when its provider is signed in on that server and
 * that server's enterprise model policy (allowlist and blocklist) permits it.
 */
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import { getProviderDisplayName } from '@ion/shared/types-models'
import { isModelAllowedByPolicy, type ModelPolicy } from '@ion/shared/enterprise-model-policy'

export interface ServerModelSlice {
  models: ModelEntry[]
  providers: ProviderEntry[]
}

/** Provider display name → that provider's usable models, in the server's own order. */
export function groupServerModels(slice: ServerModelSlice, policy: ModelPolicy | null | undefined): Map<string, ModelEntry[]> {
  const authed = new Set(slice.providers.filter((p) => p.hasAuth).map((p) => p.id))
  const out = new Map<string, ModelEntry[]>()
  for (const model of slice.models) {
    if (!authed.has(model.providerId)) continue
    if (!isModelAllowedByPolicy(model.id, policy)) continue
    const label = getProviderDisplayName(model.providerId, slice.providers)
    const list = out.get(label) ?? []
    list.push(model)
    out.set(label, list)
  }
  return out
}

/** True when `modelId` is one of the grouped models. */
export function serverOffersModel(grouped: ReadonlyMap<string, ModelEntry[]>, modelId: string): boolean {
  for (const models of grouped.values()) {
    if (models.some((m) => m.id === modelId)) return true
  }
  return false
}
