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
    getState: () => ({ preferredModel: null, engineProfiles: [] }),
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
    // The third argument is the client correlation id (the optimistic
    // bubble's own id) — passed so the engine's confirming steer_injected
    // event can re-key THIS exact bubble by identity instead of trusting
    // buffer position. See engine-slice-rewind.ts / event-slice.ts.
    expect(mockSteer).toHaveBeenCalledWith(
      'tab1',
      'steer me in a new direction',
      'steer-msg-id',
      expect.objectContaining({ messageKind: 'prompt' }),
    )
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

  it('marks the mid-turn optimistic bubble steerPending', () => {
    // The engine has not drained the steer yet. steer_injected clears this and
    // pairs the bubble with its divider; error/session_dead flip it to
    // steerFailed. Without the flag none of that lifecycle can find the bubble.
    const state = buildHarness('running')
    state.submit('tab1', 'redirect please')
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(msgs[0].steerPending).toBe(true)
  })

  it('does not mark a fresh (idle) prompt steerPending', () => {
    const state = buildHarness('idle')
    state.submit('tab1', 'a new prompt')
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(msgs[0].steerPending).toBeUndefined()
  })

  it('passes the optimistic bubble id (not a fresh id) as the steer client correlation id', () => {
    const state = buildHarness('running')
    state.submit('tab1', 'redirect please')
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    const bubbleId = msgs[0].id
    expect(mockSteer).toHaveBeenCalledWith(
      'tab1',
      'redirect please',
      bubbleId,
      expect.objectContaining({ messageKind: 'prompt' }),
    )
  })

  it('does not pass a client correlation id on an idle (non-steer) prompt', () => {
    const state = buildHarness('idle')
    state.submit('tab1', 'a new prompt')
    // window.ion.prompt, not window.ion.steer, is the call on the idle path —
    // steer must never fire for a fresh turn.
    expect(mockSteer).not.toHaveBeenCalled()
  })

  it('reuses the caller-supplied requestId as the steer message id for a remote-sourced steer', () => {
    // Regression: a remote (iOS) steer must carry the SAME id iOS's own
    // optimistic bubble uses, not a freshly-minted desktop-local msg-N id.
    // Without this, the engine's confirming steer_injected event echoes back
    // an id iOS never sent, and iOS can never resolve which pending bubble
    // the confirmation belongs to by identity — it silently falls back to an
    // "oldest pending" guess, which breaks the moment more than one steer is
    // outstanding. nextMsgId() is mocked to 'steer-msg-id'; a caller-supplied
    // requestId must win over it on this path.
    const state = buildHarness('running')
    state.submit('tab1', 'redirect please', { source: 'remote', requestId: 'ios-steer-correlation-id' })
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(msgs[0].id).toBe('ios-steer-correlation-id')
    expect(mockSteer).toHaveBeenCalledWith(
      'tab1',
      'redirect please',
      'ios-steer-correlation-id',
      expect.objectContaining({ source: 'remote', messageKind: 'prompt' }),
    )
  })

  it('mints a fresh id for a local (desktop-typed) steer even when a requestId happens to be supplied', () => {
    // Only remote-sourced steers reuse the caller's id — a local steer keeps
    // minting its own, since there is no separate optimistic bubble on
    // another client to correlate against.
    const state = buildHarness('running')
    state.submit('tab1', 'redirect please', { requestId: 'should-be-ignored' })
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(msgs[0].id).toBe('steer-msg-id')
    expect(mockSteer).toHaveBeenCalledWith(
      'tab1',
      'redirect please',
      'steer-msg-id',
      expect.objectContaining({ messageKind: 'prompt' }),
    )
  })

  it('classifies steer authorship in the metadata handed to the main process', () => {
    // The main process emits conversation:message-submitted from the steer IPC,
    // so the renderer must classify the message kind at the boundary. Never
    // inferred from text — a plain sentence beginning with a slash is still a
    // slash, a structured answer stays structured, a machine turn stays machine.
    const slash = buildHarness('running')
    slash.submit('tab1', '/align now')
    expect(mockSteer.mock.calls[0][3]).toMatchObject({ messageKind: 'slash' })

    mockSteer.mockClear()
    const structured = buildHarness('running')
    structured.submit('tab1', 'my answer', { injectionKind: 'structured_answer' })
    expect(mockSteer.mock.calls[0][3]).toMatchObject({ messageKind: 'structured' })

    mockSteer.mockClear()
    const machine = buildHarness('running')
    machine.submit('tab1', 'auto fix', { source: 'machine' })
    expect(mockSteer.mock.calls[0][3]).toMatchObject({ messageKind: 'machine' })
  })
})

describe('submitRemotePrompt — mid-turn steering (always remote-sourced)', () => {
  it('reuses the iOS-supplied reqId as the steer message id', () => {
    // submitRemotePrompt is the iOS-only entry point (CLI tabs) — reqId is
    // always the caller's own correlation id and must be reused as the
    // message id on a busy-tab (steer) send, same reasoning as submit()'s
    // remote-steer branch above.
    const state = buildHarness('running')
    state.submitRemotePrompt('tab1', 'redirect please', undefined, undefined, undefined, 'ios-reqid-123')
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(msgs[0].id).toBe('ios-reqid-123')
    expect(mockSteer).toHaveBeenCalledWith(
      'tab1',
      'redirect please',
      'ios-reqid-123',
      expect.objectContaining({ source: 'remote', messageKind: 'prompt' }),
    )
  })

  it('falls back to a generated requestId when iOS omits reqId entirely', () => {
    // requestId itself falls back to crypto.randomUUID() (not nextMsgId())
    // when reqId is absent; the steer message id must still track whatever
    // requestId resolves to, since the two are the same variable in this path.
    const state = buildHarness('running')
    state.submitRemotePrompt('tab1', 'redirect please')
    const msgs = state.conversationPanes.get('tab1')?.instances.find((i: any) => i.id === 'main')?.messages ?? []
    expect(mockSteer).toHaveBeenCalledOnce()
    const [, , correlationId] = mockSteer.mock.calls[0]
    expect(msgs[0].id).toBe(correlationId)
    expect(typeof correlationId).toBe('string')
    expect(correlationId.length).toBeGreaterThan(0)
  })
})
