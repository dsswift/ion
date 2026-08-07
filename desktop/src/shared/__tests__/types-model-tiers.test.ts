import { describe, expect, it } from 'vitest'
import { CONFLICT_ASSIST_TIER, STANDARD_TIERS } from '../types-model-tiers'

describe('standard model tiers', () => {
  it('surfaces the tier required by conflict assist', () => {
    expect(STANDARD_TIERS).toContain(CONFLICT_ASSIST_TIER)
  })
})
