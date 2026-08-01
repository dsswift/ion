// ─── Known models ───

import { useModelStore } from './model-store'

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', contextWindow: 200_000 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_048_576 },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_048_576 },
  { id: 'grok-3', label: 'Grok 3', contextWindow: 131_072 },
  { id: 'grok-3-fast', label: 'Grok 3 Fast', contextWindow: 131_072 },
  { id: 'grok-3-mini', label: 'Grok 3 Mini', contextWindow: 131_072 },
  { id: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast', contextWindow: 131_072 },
  { id: 'grok-2', label: 'Grok 2', contextWindow: 131_072 },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 65_536 },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 65_536 },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', contextWindow: 131_072 },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', contextWindow: 131_072 },
  { id: 'mistral-large-latest', label: 'Mistral Large', contextWindow: 131_072 },
  { id: 'mistral-small-latest', label: 'Mistral Small', contextWindow: 131_072 },
  { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', contextWindow: 131_072 },
  { id: 'llama-3.1-8b', label: 'Llama 3.1 8B', contextWindow: 131_072 },
] as const

/** One entry in the model-picker list (element type of AVAILABLE_MODELS). */
export type AvailableModel = (typeof AVAILABLE_MODELS)[number]

/**
 * Filter the model list against the enterprise allowedModels policy (D-011).
 * An empty or absent allowlist means no restriction — the full list is
 * returned, preserving open-source behavior. Enforcement is engine-side
 * (disallowed per-run overrides are rejected at dispatch); this filter is
 * the UI half: a general user in a model-restricted deployment should never
 * see models they cannot select.
 *
 * Pure function (no store imports) so it stays trivially testable; reactive
 * consumers pair it with `usePreferencesStore((s) =>
 * s.enterprisePolicy?.allowedModels)`.
 */
export function getFilteredModels(allowedModels?: string[] | null): readonly AvailableModel[] {
  if (!allowedModels || allowedModels.length === 0) return AVAILABLE_MODELS
  const allowed = new Set(allowedModels)
  return AVAILABLE_MODELS.filter((m) => allowed.has(m.id))
}

/**
 * Find a model in the static catalog, matching an exact id or an id that
 * extends a catalog entry with a dated suffix (`claude-opus-4-7-20260101`).
 *
 * Shared by getModelContextWindow and isKnownModel so "which window does the
 * catalog give this id" and "does the catalog know this id at all" can never
 * answer from different match rules.
 */
function findCatalogModel(modelId: string): AvailableModel | undefined {
  const normalizedId = normalizeModelId(modelId)
  return AVAILABLE_MODELS.find((m) => normalizedId === m.id || normalizedId.startsWith(m.id + '-'))
}

/**
 * True when the static catalog carries a window for this id, i.e. when
 * getModelContextWindow returns real metadata rather than its 200k floor.
 * getDynamicContextWindow uses this to tell "the catalog knows better" apart
 * from "the catalog is guessing".
 */
function isKnownModel(modelId: string): boolean {
  return findCatalogModel(modelId) !== undefined
}

export function getModelContextWindow(modelId: string): number {
  return findCatalogModel(modelId)?.contextWindow ?? 200_000
}

function normalizeModelId(modelId: string): string {
  return modelId.replace(/\[[^\]]+\]/g, '').trim()
}

export function getModelDisplayLabel(modelId: string): string {
  const normalizedId = normalizeModelId(modelId)
  const has1MContext = /\[\s*1m\s*\]/i.test(modelId)

  const known = AVAILABLE_MODELS.find((m) => m.id === normalizedId)
  if (known) {
    return has1MContext ? `${known.label} (1M)` : known.label
  }

  const compact = normalizedId
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
  // Match "family-major-minor" (e.g. sonnet-4-6 → Sonnet 4.6)
  const familyMatch = compact.match(/^([a-z]+)-(\d+)-(\d+)$/i)
  if (familyMatch) {
    const family = familyMatch[1][0].toUpperCase() + familyMatch[1].slice(1).toLowerCase()
    const label = `${family} ${familyMatch[2]}.${familyMatch[3]}`
    return has1MContext ? `${label} (1M)` : label
  }
  // Match "family-major" (e.g. fable-5 → Fable 5)
  const singleVersionMatch = compact.match(/^([a-z]+)-(\d+)$/i)
  if (singleVersionMatch) {
    const family = singleVersionMatch[1][0].toUpperCase() + singleVersionMatch[1].slice(1).toLowerCase()
    const label = `${family} ${singleVersionMatch[2]}`
    return has1MContext ? `${label} (1M)` : label
  }

  return has1MContext ? `${normalizedId} (1M)` : normalizedId
}

/**
 * Get context window for a model.
 *
 * Resolution order:
 *   1. The dynamic model store — live metadata the engine discovered from the
 *      provider. Always the best answer when present.
 *   2. `engineWindow` — the window the ENGINE reported for the model it
 *      actually ran (`statusFields.contextWindow`). Consulted before the
 *      static catalog because it is observed fact rather than a compiled-in
 *      guess, and it is populated on every status event.
 *   3. The static `AVAILABLE_MODELS` catalog, then its 200k floor.
 *
 * Step 2 exists because steps 1 and 3 can both miss. The dynamic store is
 * empty until the first `listModels` resolves (cold start), and the static
 * catalog only knows the models compiled into it — a model id absent from both
 * silently fell back to 200k, which rendered a 1M-window conversation at 128%
 * with no indication anything had been guessed.
 *
 * A model the catalog DOES know still overrides `engineWindow`. That is
 * load-bearing for the picker: selecting a 200k model for a conversation the
 * engine last ran at 1M must immediately read as over-budget, and only
 * client-side arithmetic against the selected model can do that.
 */
export function getDynamicContextWindow(modelId: string, engineWindow?: number | null): number {
  const entry = useModelStore.getState().findModel(modelId)
  if (entry) return entry.contextWindow
  if (!isKnownModel(modelId) && engineWindow && engineWindow > 0) return engineWindow
  return getModelContextWindow(modelId)
}
