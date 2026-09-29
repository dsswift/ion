/**
 * model-tier-choices — the rows and select options of the model tiers table.
 * Built-in tiers always come first, configured or not; a configured model
 * the engine does not advertise stays listed as "(unavailable)" so the
 * control never misreports what is saved.
 */
import { STANDARD_TIERS, type ModelTier } from '@ion/shared/types-model-tiers'
import { groupModelChoices } from '@ion/shared/model-identity'

export interface ModelChoice { value: string; unavailable: boolean }

export function isBuiltInTier(name: string): boolean {
  return STANDARD_TIERS.includes(name as typeof STANDARD_TIERS[number])
}

export function orderedTiers(tiers: ModelTier[]): ModelTier[] {
  const byName = new Map(tiers.map((tier) => [tier.name, tier]))
  return [
    ...STANDARD_TIERS.map((name) => byName.get(name) ?? { name, model: '', fallbacks: [] }),
    ...tiers.filter((tier) => !isBuiltInTier(tier.name)),
  ]
}

/** Provider id → choices: the engine's models, plus any configured value it does not advertise. */
export function modelChoices(available: Array<{ id: string; providerId: string }>, ...configured: Array<string | undefined>): Map<string, ModelChoice[]> {
  const groups = new Map<string, ModelChoice[]>()
  for (const [providerId, entries] of groupModelChoices(available)) {
    groups.set(providerId, entries.map(({ value }) => ({ value, unavailable: false })))
  }
  const known = new Set(Array.from(groups.values()).flat().map((entry) => entry.value))
  for (const value of configured) {
    if (!value || known.has(value)) continue
    const providerId = value.includes('/') ? value.slice(0, value.indexOf('/')) : 'Unknown'
    const entries = groups.get(providerId) ?? []
    entries.push({ value, unavailable: true })
    groups.set(providerId, entries)
  }
  return groups
}
