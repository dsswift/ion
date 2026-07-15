/**
 * Tests for the restore-time plan-mode re-assert helpers in
 * useTabRestoration-helpers.ts.
 *
 * Plan-file continuity: when a plan-mode conversation is restored after
 * restart, the re-assert must forward the persisted planFilePath so the engine
 * RE-ADOPTS the existing plan instead of allocating a fresh slug on the next
 * plan-mode prompt. `planPathForRestore` is the pure path-selection rule;
 * `reassertRestoredPlanMode` resolves the mode and issues the IPC call.
 *
 * Revert contract: dropping the 4th arg from the setPermissionMode call in
 * reassertRestoredPlanMode makes the "forwards path in plan mode" assertion
 * go red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { planPathForRestore, reassertRestoredPlanMode } from '../useTabRestoration-helpers'
import type { PersistedConversationInstance } from '../../../shared/types-persistence'

function makeInst(overrides: Partial<PersistedConversationInstance> = {}): PersistedConversationInstance {
  return {
    id: 'main',
    label: '',
    messages: [],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    planFilePath: null,
    ...overrides,
  }
}

describe('planPathForRestore', () => {
  it('returns the plan path when restoring into plan mode', () => {
    const inst = makeInst({ permissionMode: 'plan', planFilePath: '/p/plan.md' })
    expect(planPathForRestore('plan', inst)).toBe('/p/plan.md')
  })

  it('returns undefined on auto mode even when a path is persisted', () => {
    const inst = makeInst({ planFilePath: '/p/plan.md' })
    expect(planPathForRestore('auto', inst)).toBeUndefined()
  })

  it('returns undefined when no path is persisted', () => {
    expect(planPathForRestore('plan', makeInst())).toBeUndefined()
  })

  it('returns undefined for a null instance', () => {
    expect(planPathForRestore('plan', null)).toBeUndefined()
  })
})

describe('reassertRestoredPlanMode', () => {
  const setPermissionMode = vi.fn()

  beforeEach(() => {
    setPermissionMode.mockReset()
    ;(globalThis as any).window = { ion: { setPermissionMode } }
  })

  it('re-asserts plan mode AND forwards the persisted plan path', () => {
    const inst = makeInst({ permissionMode: 'plan', planFilePath: '/Users/josh/.ion/plans/bold-guiding-kite.md' })
    reassertRestoredPlanMode('tab-1', inst, undefined)
    expect(setPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'tab_restore', '/Users/josh/.ion/plans/bold-guiding-kite.md')
  })

  it('re-asserts auto mode without a path', () => {
    const inst = makeInst({ permissionMode: 'auto', planFilePath: '/p/plan.md' })
    reassertRestoredPlanMode('tab-1', inst, undefined)
    expect(setPermissionMode).toHaveBeenCalledWith('tab-1', 'auto', 'tab_restore', undefined)
  })

  it('falls back to the legacy tab-level mode for pre-WI-002 saves', () => {
    const inst = makeInst({ permissionMode: undefined as any, planFilePath: '/p/plan.md' })
    reassertRestoredPlanMode('tab-1', inst, 'plan')
    expect(setPermissionMode).toHaveBeenCalledWith('tab-1', 'plan', 'tab_restore', '/p/plan.md')
  })

  it('defaults to auto when neither instance nor legacy mode is set', () => {
    reassertRestoredPlanMode('tab-1', null, undefined)
    expect(setPermissionMode).toHaveBeenCalledWith('tab-1', 'auto', 'tab_restore', undefined)
  })
})
