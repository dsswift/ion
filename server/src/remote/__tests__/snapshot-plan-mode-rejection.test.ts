/**
 * A phone learns why its plan-mode toggle reverted only from the snapshot, so
 * the refusal must survive projection, and be absent when there is none.
 */
import { describe, it, expect } from 'vitest'
import { projectRendererTab } from '../snapshot-project'

const BASE = { lastMessage: null, permissionQueue: [] }

describe('snapshot: planModeRejection', () => {
  it('projects the refusal onto RemoteTabState', () => {
    const rejection = { requestedEnabled: true, reason: 'stay in auto', source: 'wire', at: 1 }
    const result = projectRendererTab({ id: 't1', permissionMode: 'auto', planModeRejection: rejection }, BASE)
    expect(result.planModeRejection).toEqual(rejection)
    expect(result.permissionMode).toBe('auto')
  })

  it('omits it when nothing was refused', () => {
    const result = projectRendererTab({ id: 't1', planModeRejection: null }, BASE)
    expect('planModeRejection' in result && result.planModeRejection !== undefined).toBe(false)
  })
})
