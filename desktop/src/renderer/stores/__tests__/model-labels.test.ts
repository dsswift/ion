import { describe, it, expect, beforeEach } from 'vitest'
import { AVAILABLE_MODELS, getFilteredModels, getDynamicContextWindow, getModelContextWindow } from '../model-labels'
import { useModelStore } from '../model-store'

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

/**
 * Context-window resolution.
 *
 * The denominator behind every context-occupancy percentage. Three sources,
 * in priority order: the dynamic model store (live provider metadata), the
 * engine-reported window (what the engine actually ran), then the static
 * catalog and its 200k floor.
 *
 * The floor is the defect this covers. A model id absent from BOTH the dynamic
 * store and the static catalog silently resolved to 200_000 — so a 1M-window
 * conversation holding 255,897 tokens rendered at 128% with no indication a
 * guess had been made. Live-discovered gateway models (a private provider
 * serving ids the compiled catalog has never heard of) hit this on every cold
 * start, before the first listModels call resolves.
 */
describe('getDynamicContextWindow', () => {
  beforeEach(() => {
    // The dynamic store is empty on cold start; that is the condition under test.
    useModelStore.setState({ models: [], providers: [] })
  })

  it('prefers the dynamic model store over everything else', () => {
    useModelStore.setState({
      models: [{ id: 'claude-sonnet-4-6', providerId: 'anthropic', contextWindow: 500_000 } as never],
    })
    // Beats both the engine window and the static catalog's 1M entry.
    expect(getDynamicContextWindow('claude-sonnet-4-6', 999)).toBe(500_000)
  })

  it('uses the engine-reported window for a model neither source knows', () => {
    // A live-discovered gateway model. Without the engine window this returns
    // the 200k floor and the ring reads ~128% for a 26%-full conversation.
    expect(getDynamicContextWindow('claude-opus-5', 1_000_000)).toBe(1_000_000)
  })

  it('falls back to the 200k floor when nothing knows the model', () => {
    // Pins that the floor is still the last resort, not that it is unreachable.
    expect(getDynamicContextWindow('some-unknown-model')).toBe(200_000)
    expect(getDynamicContextWindow('some-unknown-model', null)).toBe(200_000)
    expect(getDynamicContextWindow('some-unknown-model', 0)).toBe(200_000)
  })

  it('lets a known catalog model override the engine window', () => {
    // Load-bearing for the model picker: selecting a 200k model for a
    // conversation the engine last ran at 1M must immediately read
    // over-budget. Only client-side arithmetic against the SELECTED model can
    // do that, so a catalog hit must win over the engine's reported window.
    expect(getDynamicContextWindow('claude-haiku-4-5-20251001', 1_000_000)).toBe(200_000)
    expect(getModelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
  })

  it('still resolves a dated variant of a catalog model', () => {
    // The catalog match accepts a dated suffix, so a pinned build resolves to
    // its family's window rather than dropping to the floor.
    expect(getDynamicContextWindow('claude-sonnet-4-6-20260101')).toBe(
      getModelContextWindow('claude-sonnet-4-6'),
    )
  })
})
