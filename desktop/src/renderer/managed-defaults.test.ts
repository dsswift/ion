import { describe, it, expect, beforeEach } from 'vitest'
import {
  hasAppliedManagedDefault,
  markManagedDefaultApplied,
  _resetManagedDefaultsForTest,
} from './managed-defaults'

beforeEach(() => {
  _resetManagedDefaultsForTest()
})

describe('managed defaults marker', () => {
  // The whole contract: an unlocked policy seeds a value once, and after that
  // the user owns the setting.
  it('reports unapplied before, applied after', () => {
    expect(hasAppliedManagedDefault('tabStrip')).toBe(false)
    markManagedDefaultApplied('tabStrip')
    expect(hasAppliedManagedDefault('tabStrip')).toBe(true)
  })

  it('is idempotent', () => {
    markManagedDefaultApplied('tabStrip')
    markManagedDefaultApplied('tabStrip')
    expect(JSON.parse(localStorage.getItem('ion_managedDefaultsApplied') ?? '[]')).toEqual(['tabStrip'])
  })

  // The defect this replaced: the first marker used "is the key present in
  // settings.json", but the desktop rewrites the entire settings object on
  // every save, so all 87 keys exist from the first unrelated preference
  // write. The marker must be independent of the settings object entirely.
  it('does not live in the settings object', () => {
    markManagedDefaultApplied('tabStrip')
    expect(localStorage.getItem('ion_managedDefaultsApplied')).toContain('tabStrip')
  })

  // A corrupt marker must not wedge startup, and must fail toward re-applying
  // the operator's intended value rather than silently keeping a stale one.
  it.each([['not json'], ['{"not":"an array"}'], ['[1,2,3]']])(
    'treats a corrupt marker (%s) as unapplied',
    (raw) => {
      localStorage.setItem('ion_managedDefaultsApplied', raw)
      expect(hasAppliedManagedDefault('tabStrip')).toBe(false)
    },
  )
})
