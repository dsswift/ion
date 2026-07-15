/**
 * Mid-turn steering for the unified `submit` action.
 *
 * The engine-vs-plain send fork collapsed into a single `submit` (send-slice).
 * This pins the mid-turn steer behavior that used to live in submitEnginePrompt:
 *   - tab.status === 'running' → route through window.ion.steer (not prompt),
 *     and insert an optimistic user bubble so the steer shows in scrollback.
 *   - tab.status === 'idle'    → route through window.ion.prompt (a fresh turn).
 * Using prompt mid-turn would enqueue-after-the-turn instead of steering; using
 * steer when idle would drop the message. These tests fail on either confusion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({ thinkingEnabled: false, preferredModel: null, engineProfiles: [] }),
  },
}))

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'steer-msg-id'),
  playNotificationIfHidden: vi.fn(),
  cancelDoneGroupMove: vi.fn(() => false),
}))

const mockSteer = vi.fn()
const mockPrompt = vi.fn().mockResolvedValue(undefined)
const mockSetPermissionMode = vi.fn()

beforeEach(() => {
  mockSteer.mockClear()
  mockPrompt.mockClear()
  mockSetPermissionMode.mockClear()
  ;(globalThis as any).window = {
    ...(globalThis as any).window,
    ion: { steer: mockSteer, prompt: mockPrompt, setPermissionMode: mockSetPermissionMode },
  }
})

import { createSendSlice } from '../slices/send-slice'

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null,
    sessionModel: null, permissionMode: 'auto', permissionDenied: null,
    permissionQueue: [], elicitationQueue: [], conversationIds: [], draftInput: '', agentStates: [],
    statusFields: null, planFilePath: null,     contextBreakdown: null,
  }
}

function buildHarness(tabStatus: 'idle' | 'running' | 'connecting') {
  const state: any = {
    tabs: [{
      id: 'tab1', status: tabStatus, permissionMode: 'auto', lastEventAt: 0,
      permissionDenied: null, attachments: [], bashResults: [], additionalDirs: [],
      hasChosenDirectory: true, workingDirectory: '/tmp', title: 'T',
      conversationId: null, engineProfileId: null, forkedFromSessionId: null,
      thinkingEffort: 'off',
    }],
    staticInfo: { homePath: '/home' },
    enginePinnedPrompt: new Map(),
    scrollToBottomCounter: 0,
    conversationPanes: new Map([['tab1', { instances: [makeInstance('main')], activeInstanceId: 'main' }]]),
    applySendAutoGroupMove: vi.fn(),
  }
  const set = (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  const get = () => state
  const slice = createSendSlice(set as any, get as any)
  Object.assign(state, slice)
  return state
}

describe('submit — mid-turn steering', () => {
  it('routes through steer (not prompt) when the tab is running', () => {
    const state = buildHarness('running')
    state.submit('tab1', 'steer me in a new direction')
    expect(mockSteer).toHaveBeenCalledOnce()
    expect(mockSteer).toHaveBeenCalledWith('tab1', 'steer me in a new direction')
    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it('routes through prompt (not steer) when the tab is idle', () => {
    const state = buildHarness('idle')
    state.submit('tab1', 'a new prompt')
    expect(mockPrompt).toHaveBeenCalledOnce()
    expect(mockSteer).not.toHaveBeenCalled()
  })

  it('inserts an optimistic user bubble when steering mid-turn', () => {
    const state = buildHarness('running')
    state.submit('tab1', 'redirect please')
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('redirect please')
  })
})
