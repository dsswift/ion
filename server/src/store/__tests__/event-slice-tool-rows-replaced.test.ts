/**
 * The reducer's tool arms replace the row they change; they never edit it.
 *
 * Regression context: tool_call_update, tool_call_complete, tool_result, and
 * background_work_delivered copied the message array but edited the row
 * OBJECT in place. The previous list holds that same object, so the commit's
 * identity check saw an unchanged list and kept the old instance: the store
 * never reported the change. Studio's tool row showed no streamed input, and
 * a subscriber diffing the store saw nothing until a later event replaced the
 * array.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'local-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn((u: any) => u?.input_tokens ?? 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, autoGroupMovement: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({ handleCrossNormalizedEvent: vi.fn(() => false) }))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function harness(messages: any[]) {
  const state: any = {
    tabs: [{ id: 'tab1', status: 'running', lastEventAt: 0, permissionMode: 'auto', permissionDenied: null, contextTokens: 0, contextPercent: 0, hasUnread: false, queuedPrompts: [], historicalSessionIds: [], activeRequestId: null, currentActivity: '' }],
    activeTabId: 'tab1',
    engineWorkingMessages: new Map(), engineNotifications: new Map(), engineDialogs: new Map(), enginePinnedPrompt: new Map(), engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{
      id: 'main', label: 'main', messages, messageCount: messages.length, modelOverride: null, sessionModel: null,
      permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [], conversationIds: [], draftInput: '',
      agentStates: [], statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
    }], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  const slice = createEventSlice(set, () => state as State) as State
  const rows = () => activeInstance(state.conversationPanes, 'tab1')!.messages
  return { slice, rows }
}

const toolRow = () => ({ id: 't1', role: 'tool', content: '', toolName: 'Bash', toolId: 't1', toolInput: '', toolStatus: 'running', timestamp: 1, backgroundTaskId: 'bg1' })

describe('tool arms replace the row they change', () => {
  it('tool_call_update', () => {
    const original = toolRow()
    const { slice, rows } = harness([original])
    const before = rows()
    slice.handleNormalizedEvent('tab1', { type: 'tool_call_update', toolId: 't1', partialInput: '{"a":1}' } as any)
    expect(rows()).not.toBe(before)
    expect(rows()[0].toolInput).toBe('{"a":1}')
    expect(original.toolInput).toBe('')
  })

  it('tool_call_complete', () => {
    const original = toolRow()
    const { slice, rows } = harness([original])
    slice.handleNormalizedEvent('tab1', { type: 'tool_call_complete', index: 0 } as any)
    expect(rows()[0].toolStatus).toBe('completed')
    expect(original.toolStatus).toBe('running')
  })

  it('tool_result', () => {
    const original = toolRow()
    const { slice, rows } = harness([original])
    const before = rows()
    slice.handleNormalizedEvent('tab1', { type: 'tool_result', toolId: 't1', content: 'ok', isError: false } as any)
    expect(rows()).not.toBe(before)
    expect(rows()[0]).toMatchObject({ content: 'ok', toolStatus: 'completed' })
    expect(original.content).toBe('')
  })

  it('background_work_delivered', () => {
    const original = toolRow()
    const { slice, rows } = harness([original])
    slice.handleNormalizedEvent('tab1', {
      type: 'background_work_delivered', entryId: 'bw1', content: '',
      work: { kind: 'task', deliveryMode: 'fold', items: [{ id: 'bg1', status: 'completed' }] },
    } as any)
    expect(rows()[0].toolStatus).toBe('completed')
    expect(rows()[0].backgroundWork).toBeDefined()
    expect(original.toolStatus).toBe('running')
    expect((original as any).backgroundWork).toBeUndefined()
  })
})
