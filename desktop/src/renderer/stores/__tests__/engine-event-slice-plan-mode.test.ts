/**
 * engine-event-slice — engine_plan_mode_changed divider insertion
 *
 * Pins the contract that engine_plan_mode_changed { planModeEnabled: true }
 * appends a "── Plan created at <time> ──" system message into the instance's
 * messages in conversationPanes for the corresponding instance key. Mirrors the
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

function makeInstance(id: string) {
  return { id, label: id, messages: [], modelOverride: null, permissionMode: 'auto', permissionDenied: null, conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null }
}

function buildHarness() {
  const state: any = {
    tabs: [{
      id: 'tab1',
      hasEngineExtension: true,
      status: 'running',
      lastEventAt: 0,
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
    }],
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [makeInstance('inst1')], activeInstanceId: 'inst1' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

function getMessages(state: any, tabId: string, instanceId: string) {
  const pane = state.conversationPanes.get(tabId)
  return pane?.instances.find((i: any) => i.id === instanceId)?.messages ?? []
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

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^── Plan created at /)
    expect(msgs[0].content).toContain('my-plan')
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

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toMatch(/^── Plan created at [^·]+──$/)
  })

  it('does NOT insert a divider on planModeEnabled=false (proposal, not transition)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_plan_mode_changed',
      planModeEnabled: false,
      planFilePath: '/tmp/plan.md',
    } as any)

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs.length).toBe(0)
  })

  it('appends repeated dividers on multiple plan-mode entries', () => {
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

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs.length).toBe(2)
    expect(msgs[0].content).toContain('first')
    expect(msgs[0].planFilePath).toBe('/tmp/plan-1.md')
    expect(msgs[1].content).toContain('second')
    expect(msgs[1].planFilePath).toBe('/tmp/plan-2.md')
  })
})
