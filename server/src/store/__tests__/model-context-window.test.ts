/**
 * getModelContextWindow — the static fallback used by
 * StatusBarContextIndicator before the dynamic model store populates.
 *
 * Model names are not derived from ids on the client; the engine supplies
 * them (see packages/shared getModelDisplayLabel).
 */

import { describe, it, expect } from 'vitest'
import { getModelContextWindow } from '../model-labels'

// ─── TC-009: getModelContextWindow fallback table ───
// Guards the static lookup used before the dynamic store populates.
// The root cause of the 200K display bug was claude-opus-4-7 missing here.

describe('TC-009: getModelContextWindow static fallback', () => {
  it('returns 1_000_000 for claude-opus-4-7', () => {
    expect(getModelContextWindow('claude-opus-4-7')).toBe(1_000_000)
  })

  it('returns 1_000_000 for claude-opus-4-6', () => {
    expect(getModelContextWindow('claude-opus-4-6')).toBe(1_000_000)
  })

  it('returns 200_000 for claude-sonnet-4-6', () => {
    expect(getModelContextWindow('claude-sonnet-4-6')).toBe(200_000)
  })

  it('returns 200_000 for completely unknown model ids', () => {
    expect(getModelContextWindow('claude-unknown-99-99')).toBe(200_000)
  })

  it('strips [1m] bracket before lookup — still resolves 1_000_000 for opus-4-7[1m]', () => {
    expect(getModelContextWindow('claude-opus-4-7[1m]')).toBe(1_000_000)
  })
})
