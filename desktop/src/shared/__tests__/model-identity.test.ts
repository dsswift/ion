import { describe, expect, it } from 'vitest'
import {
  findModelEntry,
  groupModelChoices,
  modelIdentityLabel,
  normalizeModelPreferences,
  resolveLegacyModelId,
} from '../model-identity'
import type { ModelEntry } from '../types-models'

function model(id: string, providerId: string, displayName?: string): ModelEntry {
  return { id, providerId, displayName, contextWindow: 0, costPer1kInput: 0, costPer1kOutput: 0 }
}

describe('model identity', () => {
  describe('groupModelChoices', () => {
    it('uses engine model.id as the choice value', () => {
      const groups = groupModelChoices([model('gpt-5.6-sol', 'dci-marketing')])
      expect(groups.get('dci-marketing')?.[0].value).toBe('gpt-5.6-sol')
    })

    it('preserves engine-qualified IDs verbatim', () => {
      const groups = groupModelChoices([model('openrouter/deepseek/deepseek-chat', 'openrouter')])
      expect(groups.get('openrouter')?.[0].value).toBe('openrouter/deepseek/deepseek-chat')
    })
  })

  describe('findModelEntry', () => {
    it('matches on engine model.id', () => {
      const m = model('claude-opus-4-6', 'anthropic')
      expect(findModelEntry('claude-opus-4-6', [m])).toBe(m)
    })

    it('does not match legacy qualified form against bare engine ID', () => {
      expect(findModelEntry('anthropic/claude-opus-4-6', [model('claude-opus-4-6', 'anthropic')])).toBeUndefined()
    })

    it('matches engine-qualified IDs when engine advertises them', () => {
      const m = model('openrouter/deepseek-chat', 'openrouter')
      expect(findModelEntry('openrouter/deepseek-chat', [m])).toBe(m)
    })
  })

  describe('modelIdentityLabel', () => {
    it('shows the engine-supplied friendly name for a live model (matches the picker)', () => {
      const m = model('claude-fable-5-1', 'anthropic', 'Claude Fable 5.1')
      expect(modelIdentityLabel('claude-fable-5-1', [m])).toBe('Claude Fable 5.1')
    })

    it('falls back to the derived label when the live entry carries no displayName', () => {
      const m = model('claude-opus-4-6', 'anthropic')
      expect(modelIdentityLabel('claude-opus-4-6', [m])).toBe('Opus 4.6')
    })

    it('marks a model absent from the live set as unavailable, by id', () => {
      expect(modelIdentityLabel('claude-fable-5-1', [])).toBe('claude-fable-5-1 (unavailable)')
    })
  })

  describe('resolveLegacyModelId', () => {
    it('returns engine ID unchanged when it matches a live model', () => {
      expect(resolveLegacyModelId('claude-opus-4-6', [model('claude-opus-4-6', 'anthropic')])).toBe('claude-opus-4-6')
    })

    it('strips provider prefix from legacy qualified ID when bare matches one model', () => {
      expect(resolveLegacyModelId('dci-marketing/gpt-5.6-sol', [model('gpt-5.6-sol', 'dci-marketing')])).toBe('gpt-5.6-sol')
    })

    it('preserves ambiguous legacy qualified ID when bare matches multiple models', () => {
      expect(resolveLegacyModelId('anthropic/claude-opus-5', [
        model('claude-opus-5', 'anthropic'),
        model('claude-opus-5', 'gateway'),
      ])).toBe('anthropic/claude-opus-5')
    })

    it('preserves unrecognized legacy qualified ID', () => {
      expect(resolveLegacyModelId('unknown/some-model', [model('other-model', 'other')])).toBe('unknown/some-model')
    })

    it('returns empty string unchanged', () => {
      expect(resolveLegacyModelId('', [model('a', 'b')])).toBe('')
    })

    it('returns bare unrecognized ID unchanged', () => {
      expect(resolveLegacyModelId('no-such-model', [model('other', 'p')])).toBe('no-such-model')
    })
  })

  describe('normalizeModelPreferences', () => {
    it('normalizes legacy qualified preferences to engine-canonical bare IDs', () => {
      expect(normalizeModelPreferences({
        preferredModel: 'provider/model-a',
        engineDefaultModel: '',
        planModeModel: 'provider/model-a',
        implementModeModel: 'provider/model-a',
      }, [model('model-a', 'provider')])).toEqual({
        preferredModel: 'model-a',
        engineDefaultModel: '',
        planModeModel: 'model-a',
        implementModeModel: 'model-a',
      })
    })

    it('preserves already-canonical engine IDs', () => {
      expect(normalizeModelPreferences({
        preferredModel: 'claude-opus-4-6',
        engineDefaultModel: 'gemini-2.5-pro',
        planModeModel: '',
        implementModeModel: '',
      }, [model('claude-opus-4-6', 'anthropic'), model('gemini-2.5-pro', 'google')])).toEqual({
        preferredModel: 'claude-opus-4-6',
        engineDefaultModel: 'gemini-2.5-pro',
        planModeModel: '',
        implementModeModel: '',
      })
    })
  })
})
