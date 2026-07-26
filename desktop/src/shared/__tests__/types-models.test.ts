/**
 * types-models.test.ts — pins the two provider/model display helpers that the
 * gateway work changed.
 *
 * getProviderDisplayName gained an optional `providers` argument so an
 * operator-configured engine.json `displayName` can beat the built-in name map.
 * getModelDisplayLabel gained a provider-qualified-id branch so a gateway copy
 * of a model is distinguishable from the same bare model on its public
 * provider — without disturbing OpenRouter-style ids whose slash is part of the
 * wire id.
 */

import { describe, it, expect } from 'vitest'
import { getProviderDisplayName, getModelDisplayLabel } from '../types-models'
import type { ModelEntry, ProviderEntry } from '../types-models'

function model(over: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'providerId'>): ModelEntry {
  return { contextWindow: 200000, costPer1kInput: 0, costPer1kOutput: 0, ...over }
}

describe('getProviderDisplayName', () => {
  it('uses the built-in name map when no provider entries are supplied', () => {
    expect(getProviderDisplayName('anthropic')).toBe('Anthropic')
    expect(getProviderDisplayName('openai')).toBe('OpenAI')
  })

  it('capitalizes an unknown provider id as the final fallback', () => {
    expect(getProviderDisplayName('dci-marketing')).toBe('Dci-marketing')
  })

  it('prefers an operator-configured displayName over the built-in map', () => {
    const providers: ProviderEntry[] = [
      { id: 'anthropic', hasAuth: true, displayName: 'Anthropic (Corp Gateway)' },
    ]
    expect(getProviderDisplayName('anthropic', providers)).toBe('Anthropic (Corp Gateway)')
  })

  it('uses a configured displayName for a provider absent from the built-in map', () => {
    const providers: ProviderEntry[] = [
      { id: 'dci-marketing', hasAuth: true, displayName: 'dci Marketing' },
    ]
    expect(getProviderDisplayName('dci-marketing', providers)).toBe('dci Marketing')
  })

  it('falls back when the entry exists but carries no displayName', () => {
    const providers: ProviderEntry[] = [{ id: 'dci-marketing', hasAuth: true }]
    expect(getProviderDisplayName('dci-marketing', providers)).toBe('Dci-marketing')
  })

  it('falls back when the provider list has no matching entry', () => {
    const providers: ProviderEntry[] = [
      { id: 'other', hasAuth: true, displayName: 'Some Other Gateway' },
    ]
    expect(getProviderDisplayName('anthropic', providers)).toBe('Anthropic')
  })
})

describe('getModelDisplayLabel', () => {
  it('maps a well-known bare model id to its friendly label', () => {
    expect(getModelDisplayLabel(model({ id: 'claude-opus-4-6', providerId: 'anthropic' }))).toBe('Opus 4.6')
  })

  it('passes an unknown bare id through unchanged', () => {
    expect(getModelDisplayLabel(model({ id: 'some-new-model', providerId: 'anthropic' }))).toBe('some-new-model')
  })

  it('labels a provider-qualified id with its known label plus the provider', () => {
    expect(getModelDisplayLabel(model({ id: 'dci-marketing/claude-opus-4-6', providerId: 'dci-marketing' })))
      .toBe('Opus 4.6 (dci-marketing)')
  })

  it('labels a provider-qualified unknown model with the bare id plus the provider', () => {
    expect(getModelDisplayLabel(model({ id: 'dci-marketing/gpt-5.2-codex', providerId: 'dci-marketing' })))
      .toBe('gpt-5.2-codex (dci-marketing)')
  })

  it('leaves an OpenRouter-style id intact (slash is part of the wire id)', () => {
    // The prefix ("deepseek") is not the providerId ("openrouter"), so the
    // qualified-id branch must not fire — the whole string is the model id.
    expect(getModelDisplayLabel(model({ id: 'deepseek/deepseek-chat', providerId: 'openrouter' })))
      .toBe('deepseek/deepseek-chat')
  })

  it('prefers an exact LABELS hit over the qualified-id branch', () => {
    // A bare id that happens to be in LABELS resolves through LABELS even
    // though a naive slash scan would find none.
    expect(getModelDisplayLabel(model({ id: 'deepseek-chat', providerId: 'deepseek' }))).toBe('DeepSeek Chat')
  })

  it('does not treat a leading slash as a provider qualifier', () => {
    expect(getModelDisplayLabel(model({ id: '/weird-id', providerId: 'anthropic' }))).toBe('/weird-id')
  })
})
