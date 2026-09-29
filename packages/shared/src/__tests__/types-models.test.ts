/**
 * types-models.test.ts — pins the two provider/model display helpers that the
 * gateway work changed.
 *
 * getProviderDisplayName gained an optional `providers` argument so an
 * operator-configured engine.json `displayName` can beat the built-in name map.
 * getModelDisplayLabel shows the engine-supplied name and nothing else: an
 * entry the engine did not name is shown by its id, never by a client-side
 * guess, so every provider's models are named by one source.
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
  it('shows the engine-supplied displayName', () => {
    expect(getModelDisplayLabel(model({ id: 'claude-fable-5-1', providerId: 'anthropic', displayName: 'Claude Fable 5.1' })))
      .toBe('Claude Fable 5.1')
  })

  it('shows the same name for a gateway copy the engine named', () => {
    expect(getModelDisplayLabel(model({ id: 'dci-marketing/claude-opus-4-8', providerId: 'dci-marketing', displayName: 'Claude Opus 4.8' })))
      .toBe('Claude Opus 4.8')
  })

  it('shows the id when the engine supplies no name, even for an id a client could guess', () => {
    // No client-side name table: a well-known id without an engine name is
    // shown as-is, exactly like any other unnamed model.
    expect(getModelDisplayLabel(model({ id: 'claude-opus-4-6', providerId: 'anthropic' }))).toBe('claude-opus-4-6')
  })

  it("drops the engine's own provider qualifier from an unnamed entry", () => {
    expect(getModelDisplayLabel(model({ id: 'dci-marketing/gpt-5.2-codex', providerId: 'dci-marketing' })))
      .toBe('gpt-5.2-codex')
  })

  it('leaves an OpenRouter-style id intact (slash is part of the wire id)', () => {
    expect(getModelDisplayLabel(model({ id: 'deepseek/deepseek-chat', providerId: 'openrouter' })))
      .toBe('deepseek/deepseek-chat')
  })
})
