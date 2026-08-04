// @vitest-environment jsdom
/**
 * `initialThinkingEffort` — the level a NEW conversation's thinking control
 * starts at.
 *
 * Seeded onto the instance at every conversation-creation site (tab-slice,
 * engine-slice-create, the initial store tab), mirroring how
 * `initialPermissionMode` seeds the permission mode.
 *
 * The gate (`thinkingEnabled`) was removed when thinking became GA. The helper
 * now reads `defaultThinkingEffort` directly and falls back to 'high'.
 *
 * Revert proof: changing the fallback or removing the preference read fails
 * the explicit-effort and absent-preference cases below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const prefState = {
  defaultThinkingEffort: 'high' as string | undefined,
  defaultPermissionMode: 'auto',
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefState },
}))
vi.mock('../../../../resources/notification.mp3', () => ({ default: '' }))
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { initialThinkingEffort } from '../session-store-helpers'

describe('initialThinkingEffort', () => {
  beforeEach(() => {
    prefState.defaultThinkingEffort = 'high'
  })

  it.each(['low', 'medium', 'high', 'off'])('returns the configured %s level', (level) => {
    prefState.defaultThinkingEffort = level
    expect(initialThinkingEffort()).toBe(level)
  })

  it("falls back to 'high' when the preference is absent", () => {
    prefState.defaultThinkingEffort = undefined
    expect(initialThinkingEffort()).toBe('high')
  })
})
