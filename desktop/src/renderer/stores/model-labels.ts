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

export function getModelContextWindow(modelId: string): number {
  const normalizedId = normalizeModelId(modelId)
  const known = AVAILABLE_MODELS.find((m) => normalizedId === m.id || normalizedId.startsWith(m.id + '-'))
  return known?.contextWindow ?? 200_000
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
  const familyMatch = compact.match(/^([a-z]+)-(\d+)-(\d+)$/i)
  if (familyMatch) {
    const family = familyMatch[1][0].toUpperCase() + familyMatch[1].slice(1).toLowerCase()
    const label = `${family} ${familyMatch[2]}.${familyMatch[3]}`
    return has1MContext ? `${label} (1M)` : label
  }

  return has1MContext ? `${normalizedId} (1M)` : normalizedId
}

/** Get context window for a model, checking dynamic model store first. */
export function getDynamicContextWindow(modelId: string): number {
  const entry = useModelStore.getState().findModel(modelId)
  if (entry) return entry.contextWindow
  return getModelContextWindow(modelId)
}
