/**
 * engine-event-slice — engine_plan_mode_changed divider insertion
 *
 * Pins the contract that engine_plan_mode_changed { planModeEnabled: true }
 * appends a "── Plan created at <time> ──" system message into the
 * engineMessages buffer for the corresponding instance key. Mirrors the
 * CLI-tab equivalent in event-slice-plan-mode.test.ts.
 *
 * Also pins the negative case: planModeEnabled=false (the model called
 * ExitPlanMode) MUST NOT insert a divider — that path is gated by the
 * desktop's user-approval chokepoint in onImplement, not the engine event.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import type { State } from '../session-store-types'

function buildHarness() {
  const state: any = {
    tabs: [{
      id: 'tab1',
      isEngine: true,
      status: 'running',
      lastEventAt: 0,
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
    }],
    engineAgentStates: new Map(),
    engineStatusFields: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineMessages: new Map(),
    engineDraftInputs: new Map(),
    engineModelOverrides: new Map(),
    engineConversationIds: new Map(),
    enginePanes: new Map(),
    enginePermissionDenied: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

describe('engine-event-slice — engine_plan_mode_changed', () => {
  it('appends a "Plan created" divider on planModeEnabled=true', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
      planSlug: 'my-plan',
    } as any)

    const msgs = state.engineMessages.get(key) ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^── Plan created at /)
    expect(msgs[0].content).toContain('my-plan')
    // planFilePath is propagated to the message so SystemMessage can
    // wire the slug as a clickable link to the plan-viewer.
    expect(msgs[0].planFilePath).toBe('/tmp/plan.md')
  })

  it('appends a slug-less divider when planSlug is missing', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan.md',
    } as any)

    const msgs = state.engineMessages.get(key) ?? []
    expect(msgs.length).toBe(1)
    // No ` · slug` segment when there is no slug.
    expect(msgs[0].content).toMatch(/^── Plan created at [^·]+──$/)
  })

  it('does NOT insert a divider on planModeEnabled=false (proposal, not transition)', () => {
    // ADR-003: planModeEnabled=false fires only on confirmed exit
    // (today: user-approval chokepoint). The model's ExitPlanMode call
    // surfaces as engine_plan_proposal, not engine_plan_mode_changed,
    // so this branch should never legitimately fire — but if it ever
    // does, the divider must not appear.
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_plan_mode_changed',
      planModeEnabled: false,
      planFilePath: '/tmp/plan.md',
    } as any)

    const msgs = state.engineMessages.get(key) ?? []
    expect(msgs.length).toBe(0)
  })

  it('appends repeated dividers on multiple plan-mode entries', () => {
    // Repeating cycle: Session started → Plan created → Implementing
    // → Plan created → Implementing → … Each plan-mode entry produces
    // its own divider; the renderer never deduplicates.
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan-1.md',
      planSlug: 'first',
    } as any)
    slice.handleEngineEvent(key, {
      type: 'engine_plan_mode_changed',
      planModeEnabled: true,
      planFilePath: '/tmp/plan-2.md',
      planSlug: 'second',
    } as any)

    const msgs = state.engineMessages.get(key) ?? []
    expect(msgs.length).toBe(2)
    expect(msgs[0].content).toContain('first')
    expect(msgs[0].planFilePath).toBe('/tmp/plan-1.md')
    expect(msgs[1].content).toContain('second')
    expect(msgs[1].planFilePath).toBe('/tmp/plan-2.md')
  })
})
