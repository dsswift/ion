import { describe, expect, it } from 'vitest'
import type { PersistedTab } from '@ion/shared/types-persistence'
import { restoreSettledHistoryRecord } from '../tab-inbox-restore'

function settledRecord(overrides: Partial<PersistedTab>): PersistedTab {
  return {
    id: 'tab-settled',
    conversationId: 'conv-settled',
    title: 'Settled',
    customTitle: null,
    workingDirectory: '/work',
    hasChosenDirectory: true,
    additionalDirs: [],
    settledAt: 1,
    ...overrides,
  }
}

describe('restoreSettledHistoryRecord', () => {
  it('keeps the owner of a settled conversation across a restart', () => {
    const restored = restoreSettledHistoryRecord(settledRecord({ principalSubject: 'local:alice' }))
    expect(restored.principalSubject).toBe('local:alice')
  })

  it('leaves a record that never had an owner without one', () => {
    const restored = restoreSettledHistoryRecord(settledRecord({}))
    expect(restored.principalSubject).toBeUndefined()
  })
})
