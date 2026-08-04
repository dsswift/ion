// @vitest-environment jsdom
/**
 * `initialThinkingEffort` — the level a NEW conversation's thinking control
 * starts at.
 *
 * Seeded onto the instance at every conversation-creation site (tab-slice,
 * engine-slice-create, the initial store tab), mirroring how
 * `initialPermissionMode` seeds the permission mode.
 *
 * The property worth pinning is the interaction with the global gate, not the
 * happy path. `thinkingEnabled` hides the per-conversation picker entirely, so
 * seeding a live level while the gate is off would put an effort on prompts
 * that the user can neither see nor change — reasoning tokens billing with no
 * visible cause and no affordance to stop it. The helper therefore reports
 * 'off' whenever the gate is off, regardless of the stored default.
 *
 * Revert proof: dropping the gate check fails the gate-off cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const prefState = {
  thinkingEnabled: false,
  defaultThinkingEffort: 'off' as string | undefined,
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
    prefState.thinkingEnabled = false
    prefState.defaultThinkingEffort = 'off'
  })

  it.each(['low', 'medium', 'high'])('returns the configured %s level when the gate is on', (level) => {
    prefState.thinkingEnabled = true
    prefState.defaultThinkingEffort = level
    expect(initialThinkingEffort()).toBe(level)
  })

  it("returns 'off' when the gate is on but the default is off", () => {
    prefState.thinkingEnabled = true
    prefState.defaultThinkingEffort = 'off'
    expect(initialThinkingEffort()).toBe('off')
  })

  // The gate wins. A level seeded while the picker is hidden would bill
  // reasoning tokens with no visible cause and no way to turn it off.
  it("returns 'off' when the gate is off, even with a high default stored", () => {
    prefState.thinkingEnabled = false
    prefState.defaultThinkingEffort = 'high'
    expect(initialThinkingEffort()).toBe('off')
  })

  it("falls back to 'high' when the preference is absent", () => {
    prefState.thinkingEnabled = true
    prefState.defaultThinkingEffort = undefined
    expect(initialThinkingEffort()).toBe('high')
  })
})
