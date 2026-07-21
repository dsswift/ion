import { describe, it, expect } from 'vitest'
import { AVAILABLE_MODELS, getFilteredModels } from '../model-labels'

// D-011: model-picker policy awareness. getFilteredModels is the pure half
// of the enterprise allowlist filter; the useAllowedModels hook wires it to
// the preferences store's enterprisePolicy.allowedModels.

describe('getFilteredModels (D-011 enterprise allowlist)', () => {
  it('returns the full list when no allowlist is provided', () => {
    expect(getFilteredModels(undefined)).toEqual(AVAILABLE_MODELS)
    expect(getFilteredModels(null)).toEqual(AVAILABLE_MODELS)
  })

  it('returns the full list for an empty allowlist (no restriction)', () => {
    expect(getFilteredModels([])).toEqual(AVAILABLE_MODELS)
  })

  it('filters to only the allowed models', () => {
    const filtered = getFilteredModels(['claude-sonnet-4-6'])
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('claude-sonnet-4-6')
  })

  it('filters to multiple allowed models preserving list order', () => {
    const filtered = getFilteredModels(['grok-3', 'claude-sonnet-4-6'])
    expect(filtered.map((m) => m.id)).toEqual(['claude-sonnet-4-6', 'grok-3'])
  })

  it('ignores allowlist entries that are not in AVAILABLE_MODELS', () => {
    const filtered = getFilteredModels(['claude-sonnet-4-6', 'nonexistent-model'])
    expect(filtered.map((m) => m.id)).toEqual(['claude-sonnet-4-6'])
  })

  it('returns an empty list when nothing matches (engine still enforces)', () => {
    expect(getFilteredModels(['nonexistent-model'])).toEqual([])
  })
})
