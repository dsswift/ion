import { describe, expect, it, vi } from 'vitest'

vi.mock('../../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(),
}))

import { forkModelSelection } from '../resume-slice-fork'

describe('forkModelSelection', () => {
  it('preserves model value and automatic provenance', () => {
    expect(forkModelSelection({ modelOverride: 'gpt-5.6-sol', modelOverrideSource: 'automatic' })).toEqual({
      modelOverride: 'gpt-5.6-sol', modelOverrideSource: 'automatic',
    })
  })

  it('preserves direct user selection provenance', () => {
    expect(forkModelSelection({ modelOverride: 'gpt-5.6-terra', modelOverrideSource: 'user' })).toEqual({
      modelOverride: 'gpt-5.6-terra', modelOverrideSource: 'user',
    })
  })
})
