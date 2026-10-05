/**
 * A vetoed plan-mode toggle. The engine did not move, so the instance must go
 * back to the mode it is really in and keep the reason to show; a later
 * applied change clears it. A client toggle that turns plan mode off is a
 * confirmed change, unlike the model's exit proposal.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

import { handlePlanModeEvent, type PlanModeCtx } from '../event-slice-plan-mode'

function ctx(inst0: PlanModeCtx['inst0']): PlanModeCtx {
  return { tabId: 't1', inst0, messages: [], instPatch: {}, instTouched: false }
}

describe('engine_plan_mode_change_rejected', () => {
  it('reverts a refused enter to auto and keeps the reason', () => {
    const c = ctx({ permissionMode: 'plan' })
    expect(handlePlanModeEvent(c, { type: 'engine_plan_mode_change_rejected', planModeRequestedEnabled: true, planModeSource: 'wire', planModeRejectReason: 'stay in auto' })).toBe(true)
    expect(c.instPatch.permissionMode).toBe('auto')
    expect(c.instPatch.planModeRejection).toMatchObject({ requestedEnabled: true, reason: 'stay in auto', source: 'wire' })
    expect(c.instTouched).toBe(true)
  })

  it('reverts a refused exit to plan', () => {
    const c = ctx({ permissionMode: 'auto' })
    handlePlanModeEvent(c, { type: 'engine_plan_mode_change_rejected', planModeSource: 'wire' })
    expect(c.instPatch.permissionMode).toBe('plan')
    expect(c.instPatch.planModeRejection?.requestedEnabled).toBe(false)
  })
})

describe('engine_plan_mode_changed', () => {
  it('a wire exit is a confirmed change to auto', () => {
    const c = ctx({ permissionMode: 'plan' })
    handlePlanModeEvent(c, { type: 'engine_plan_mode_changed', planModeEnabled: false, planModeSource: 'wire' })
    expect(c.instPatch.permissionMode).toBe('auto')
  })

  it('an unsourced exit stays a proposal and leaves the mode alone', () => {
    const c = ctx({ permissionMode: 'plan' })
    handlePlanModeEvent(c, { type: 'engine_plan_mode_changed', planModeEnabled: false })
    expect(c.instPatch.permissionMode).toBeUndefined()
  })

  it('an applied change clears an earlier refusal', () => {
    const c = ctx({ permissionMode: 'auto', planModeRejection: { requestedEnabled: true, reason: 'x', source: 'wire', at: 1 } })
    handlePlanModeEvent(c, { type: 'engine_plan_mode_changed', planModeEnabled: true, planModeSource: 'extension' })
    expect(c.instPatch.planModeRejection).toBeNull()
    expect(c.instPatch.permissionMode).toBe('plan')
  })
})
