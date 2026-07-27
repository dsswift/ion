/**
 * Coverage for normalized-event reducer arms extracted in Fix 1 (the size-cap
 * split of event-slice.ts into event-slice-extension-surface.ts,
 * event-slice-plan-mode.ts, and event-slice-task.ts).
 *
 * These arms previously had no direct test. They flow through the public
 * reducer seam (handleNormalizedEvent), so this pins the extracted behavior at
 * the same stable boundary the rest of the suite uses — not the handler
 * internals. Covers: task_update, working_message, dialog, events_dropped,
 * engine_plan_proposal.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, autoGroupMovement: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [],
    statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
  }
}

function buildHarness() {
  const state: any = {
    tabs: [{
      id: 'tab1', engineProfileId: 'test-profile', status: 'running', lastEventAt: 0,
      permissionMode: 'auto', permissionDenied: null, contextTokens: 0, contextPercent: 0,
      hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null,
      currentActivity: null,
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [makeInstance('main')], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function activeMessages(state: any) {
  return state.conversationPanes.get('tab1').instances[0].messages
}

describe('Fix 1 extracted reducer arms — task group', () => {
  it('task_update appends an assistant message when no streamed text exists yet', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'task_update',
      message: { content: [{ type: 'text', text: 'hello from the model' }] },
    } as any)
    const msgs = activeMessages(state)
    expect(msgs.some((m: any) => m.role === 'assistant' && m.content === 'hello from the model')).toBe(true)
  })

  it('task_update materializes a tool row from a tool_use block', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'task_update',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] },
    } as any)
    const msgs = activeMessages(state)
    const toolRow = msgs.find((m: any) => m.role === 'tool' && m.toolName === 'Read')
    expect(toolRow).toBeDefined()
    expect(toolRow.toolStatus).toBe('completed')
  })
})

describe('Fix 1 extracted reducer arms — extension surface', () => {
  it('working_message sets the working indicator and an empty string clears it', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', { type: 'working_message', message: 'Compacting…' } as any)
    expect(state.engineWorkingMessages.get('tab1')).toBe('Compacting…')

    slice.handleNormalizedEvent('tab1', { type: 'working_message', message: '' } as any)
    expect(state.engineWorkingMessages.has('tab1')).toBe(false)
  })

  it('dialog stores a modal prompt under the bare tabId', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'dialog', dialogId: 'd1', method: 'prompt', title: 'Name?', defaultValue: 'x',
    } as any)
    const dlg = state.engineDialogs.get('tab1')
    expect(dlg).toMatchObject({ dialogId: 'd1', method: 'prompt', title: 'Name?', defaultValue: 'x' })
  })

  it('events_dropped is a no-op on conversation state (log only)', () => {
    const { state, slice } = buildHarness()
    const before = activeMessages(state).length
    slice.handleNormalizedEvent('tab1', { type: 'events_dropped', count: 5 } as any)
    expect(activeMessages(state).length).toBe(before)
    // No working message, dialog, or notification is produced by a drop.
    expect(state.engineWorkingMessages.has('tab1')).toBe(false)
    expect(state.engineDialogs.has('tab1')).toBe(false)
  })
})

describe('Fix 1 extracted reducer arms — plan mode', () => {
  it('engine_plan_proposal records the proposed plan path on the active instance', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'engine_plan_proposal', planProposalKind: 'exit', planFilePath: '/abs/PLAN.md',
    } as any)
    const inst = state.conversationPanes.get('tab1').instances[0]
    expect(inst.planFilePath).toBe('/abs/PLAN.md')
  })
})
