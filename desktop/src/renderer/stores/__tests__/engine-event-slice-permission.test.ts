/**
 * engine-event-slice — permission denial handling
 *
 * Pins the contract that `engine_status` with `permissionDenials` containing
 * AskUserQuestion or ExitPlanMode converges with the conversation-tab
 * `task_complete` behavior: status is set to 'completed' (not 'idle') and
 * `permissionDenied` is populated so the card renders and the snapshot
 * carries the data to iOS.
 *
 * Without this convergence, the engine-event-slice races the synthesized
 * task_complete from the session plane and can clobber `permissionDenied`,
 * causing the AskUserQuestion / ExitPlanMode card to vanish on iOS restore.
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
    tabs: [{ id: 'tab1', isEngine: true, status: 'running', lastEventAt: 0, permissionDenied: null }],
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

describe('engine_status with permissionDenials — pipeline convergence', () => {
  it('AskUserQuestion denial sets status=completed and populates enginePermissionDenied', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        state: 'idle',
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { question: 'Pick one', options: ['A', 'B'] } },
        ],
      },
    } as any)

    expect(state.tabs[0].status).toBe('completed')
    // Engine tabs use enginePermissionDenied (per-instance), not tab.permissionDenied
    expect(state.tabs[0].permissionDenied).toBeNull()
    const entry = state.enginePermissionDenied.get(key)
    expect(entry).not.toBeNull()
    expect(entry.tools).toHaveLength(1)
    expect(entry.tools[0].toolName).toBe('AskUserQuestion')
    expect(entry.tools[0].toolInput).toEqual({ question: 'Pick one', options: ['A', 'B'] })
  })

  it('ExitPlanMode denial sets status=completed and populates enginePermissionDenied', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        state: 'idle',
        permissionDenials: [
          { toolName: 'ExitPlanMode', toolUseId: 'exit-1', toolInput: { planFilePath: '/tmp/plan.md' } },
        ],
      },
    } as any)

    expect(state.tabs[0].status).toBe('completed')
    expect(state.tabs[0].permissionDenied).toBeNull()
    const entry = state.enginePermissionDenied.get(key)
    expect(entry?.tools[0].toolName).toBe('ExitPlanMode')
  })

  it('engine_status idle without denials sets status=idle (normal path)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: { state: 'idle' },
    } as any)

    expect(state.tabs[0].status).toBe('idle')
    expect(state.tabs[0].permissionDenied).toBeNull()
  })

  it('non-special denials (generic tool) still set status=idle', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        state: 'idle',
        permissionDenials: [
          { toolName: 'Write', toolUseId: 'w-1', toolInput: {} },
        ],
      },
    } as any)

    // Generic tool denials don't require user response on iOS
    expect(state.tabs[0].status).toBe('idle')
    expect(state.tabs[0].permissionDenied).toBeNull()
  })

  it('subsequent idle without denials sets status=idle after prior AskUserQuestion', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    // First: AskUserQuestion denial
    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: {
        state: 'idle',
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'ask-1', toolInput: { question: 'Yes?' } },
        ],
      },
    } as any)
    expect(state.tabs[0].status).toBe('completed')
    expect(state.enginePermissionDenied.get(key)).not.toBeUndefined()

    // Simulate user answered → tab goes running → then idle again with no denials
    state.tabs[0].status = 'running'

    slice.handleEngineEvent(key, {
      type: 'engine_status',
      fields: { state: 'idle' },
    } as any)

    expect(state.tabs[0].status).toBe('idle')
    expect(state.tabs[0].permissionDenied).toBeNull()
  })
})
