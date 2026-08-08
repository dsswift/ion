// @vitest-environment jsdom
/**
 * `initialThinkingEffort` — the level a NEW conversation's thinking control
 * starts at.
 *
 * Seeded onto the instance at every conversation-creation site (tab-slice,
 * engine-slice-create, the initial store tab), mirroring how
 * `initialPermissionMode` seeds the permission mode.
 *
 * The global gate was removed when thinking became GA, so the helper now reads
 * `defaultThinkingEffort` — but it is MODEL-AWARE. An adaptive model
 * (Anthropic) self-regulates reasoning depth; pinning an explicit effort emits
 * output_config and overrides that judgment on every turn, including trivial
 * ones. With a default of "high" that produced multi-minute thinking streams
 * on simple prompts. So adaptive models start at 'adaptive' (reason, you pick
 * the depth) and effort-based models take the configured default, where the
 * level is the only way to get reasoning at all.
 *
 * Revert proof: dropping the model lookup makes the adaptive cases return
 * 'high' and fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const prefState = {
  defaultThinkingEffort: 'high' as string | undefined,
  defaultPermissionMode: 'auto',
  preferredModel: '' as string | undefined,
}

const modelsById: Record<string, { id: string; thinkingMode?: string }> = {}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefState },
}))
vi.mock('../model-store', () => ({
  useModelStore: { getState: () => ({ findModel: (id: string) => modelsById[id] }) },
}))
vi.mock('../../../../resources/notification.mp3', () => ({ default: '' }))
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { initialThinkingEffort } from '../session-store-helpers'

describe('initialThinkingEffort', () => {
  beforeEach(() => {
    prefState.defaultThinkingEffort = 'high'
    prefState.preferredModel = ''
    for (const k of Object.keys(modelsById)) delete modelsById[k]
    modelsById['claude-opus-5'] = { id: 'claude-opus-5', thinkingMode: 'adaptive' }
    modelsById['gpt-5.6-terra'] = { id: 'gpt-5.6-terra', thinkingMode: 'reasoning_effort' }
  })

  // The Opus-5 case: a self-regulating model must not be pinned by default.
  it('returns adaptive for an adaptive model regardless of the configured level', () => {
    for (const configured of ['high', 'medium', 'low']) {
      prefState.defaultThinkingEffort = configured
      expect(initialThinkingEffort('claude-opus-5')).toBe('adaptive')
    }
  })

  it('returns the configured level for an effort-based model', () => {
    prefState.defaultThinkingEffort = 'high'
    expect(initialThinkingEffort('gpt-5.6-terra')).toBe('high')
    prefState.defaultThinkingEffort = 'low'
    expect(initialThinkingEffort('gpt-5.6-terra')).toBe('low')
  })

  it('resolves the model from the preferred-model preference when none is passed', () => {
    prefState.preferredModel = 'claude-opus-5'
    expect(initialThinkingEffort()).toBe('adaptive')
    prefState.preferredModel = 'gpt-5.6-terra'
    expect(initialThinkingEffort()).toBe('high')
  })

  it('falls back to the configured level for an unknown model', () => {
    expect(initialThinkingEffort('never-registered')).toBe('high')
  })

  it('falls back to the configured level when no model can be resolved', () => {
    prefState.preferredModel = ''
    expect(initialThinkingEffort()).toBe('high')
  })

  it("falls back to 'high' when the preference is absent", () => {
    prefState.defaultThinkingEffort = undefined
    prefState.preferredModel = 'gpt-5.6-terra'
    expect(initialThinkingEffort()).toBe('high')
  })

  it('honors an explicit off for an effort-based model', () => {
    prefState.defaultThinkingEffort = 'off'
    expect(initialThinkingEffort('gpt-5.6-terra')).toBe('off')
  })
})
