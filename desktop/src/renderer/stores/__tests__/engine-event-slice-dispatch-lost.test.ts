/**
 * dispatch_lost → scrollback notice.
 *
 * REPORTED: two background agents ran for 18 minutes, then the engine
 * restarted and killed both. The engine announced each orphan
 * (engine_dispatch_lost) and the desktop consumed it nowhere, so the operator
 * saw a conversation that had simply stopped, with no reason given.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'notice-1'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function buildHarness() {
  const inst: any = {
    id: 'main', label: 'main', messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [], statusFields: null,
    planFilePath: null, thinkingEffort: 'off', sealed: false,
    messages: [{ id: 'm1', role: 'user', content: 'go', timestamp: 1 }],
  }
  const state: any = {
    tabs: [{ id: 'tab1', engineProfileId: 'p', lastEventAt: 0, status: 'idle', permissionDenied: null, contextTokens: 0, contextPercent: 0, hasUnread: false, queuedPrompts: [], historicalSessionIds: [], permissionMode: 'auto', activeRequestId: null, currentActivity: null }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [inst], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  const slice = createEventSlice(set, () => state as State) as State
  return { state, slice }
}

const rows = (state: any) => activeInstance(state.conversationPanes, 'tab1')!.messages

describe('dispatch_lost', () => {
  it('appends a system notice naming the lost agent (REGRESSION)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'dispatch_lost',
      dispatchId: 'dispatch-agent-2-1789044109138-097110fdb688',
      agentName: 'agent-2',
    } as any)

    const last = rows(state)[rows(state).length - 1]
    expect(last.role).toBe('system')
    expect(last.content).toContain('agent-2 was lost when the engine restarted at')
  })

  it('announces every orphan — a restart loses each dispatch separately', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', { type: 'dispatch_lost', dispatchId: 'd1', agentName: 'agent-1' } as any)
    slice.handleNormalizedEvent('tab1', { type: 'dispatch_lost', dispatchId: 'd2', agentName: 'agent-2' } as any)

    const systemRows = rows(state).filter((m: any) => m.role === 'system')
    expect(systemRows).toHaveLength(2)
    expect(systemRows[0].content).toContain('agent-1')
    expect(systemRows[1].content).toContain('agent-2')
  })

  it('leaves the transcript alone for any other event', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', { type: 'text_chunk', text: 'hi' } as any)
    expect(rows(state).filter((m: any) => m.role === 'system')).toHaveLength(0)
  })
})
