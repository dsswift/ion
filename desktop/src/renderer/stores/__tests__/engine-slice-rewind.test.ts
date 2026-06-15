/**
 * engine-slice-rewind — unit tests
 *
 * Tests rewindEngineInstance's target resolution in isolation over a hand-built
 * set/get pair. Two resolution paths matter:
 *   - id match (desktop-initiated rewind): messageId present in inst.messages.
 *   - user-turn ordinal fallback (iOS-initiated rewind): messageId is an
 *     optimistic UUID the desktop never minted, so we resolve the Nth
 *     role==='user' message via userTurnIndex.
 *
 * The ordinal path is pinned against a message list with interleaved
 * tool/assistant rows to lock the invariant that user-turn ordinal is stable
 * regardless of interleaving (the whole reason ordinal beats raw index).
 *
 * It also verifies the post-restart broadcast: rewindEngineInstance must call
 * window.ion.engineBroadcastHistory after the fresh session starts so remote
 * devices receive the truncated history.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({})),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      defaultBaseDirectory: '',
      tabGroupMode: 'auto',
      tabGroups: [],
      engineProfiles: [],
      engineDefaultModel: '',
      preferredModel: '',
    }),
  },
}))

import { createEngineRewindActions } from '../slices/engine-slice-rewind'
import type { State } from '../session-store-types'
import type { ConversationRef, ConversationPane, ConversationInstance } from '../../../shared/types-engine'
import { formatClearDivider } from '../../../shared/clear-divider'

function makeTab(id: string) {
  return {
    id,
    title: 'Engine',
    hasEngineExtension: true,
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: false,
    pillIcon: 'lightning',
    groupId: null,
    status: 'idle',
    customTitle: null,
    pillColor: null,
  }
}

function makeInstance(
  id: string,
  messages: Array<{ id: string; role: string; content: string; timestamp: number; toolName?: string }>,
): ConversationRef & ConversationInstance {
  return {
    id,
    label: 'Engine',
    messages: messages as any,
    messageCount: messages.length,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    conversationIds: ['conv-prior'],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    forkedFromConversationIds: null,
  }
}

function buildHarness(messages: Array<{ id: string; role: string; content: string; timestamp: number; toolName?: string }>) {
  const state: any = {
    tabs: [makeTab('tab1')],
    conversationPanes: new Map<string, ConversationPane>([
      ['tab1', { instances: [makeInstance('inst1', messages)], activeInstanceId: 'inst1' }],
    ]),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineRewindActions(set, get) as State
  return { state, slice }
}

// A representative engine instance message list: two user turns with
// interleaved assistant + tool rows. User-turn ordinal 0 = first user msg;
// ordinal 1 = second user msg.
const INTERLEAVED = [
  { id: 'u-real-0', role: 'user', content: 'first prompt', timestamp: 1 },
  { id: 'a-1', role: 'assistant', content: 'thinking', timestamp: 2 },
  { id: 't-1', role: 'tool', content: 'ran tool', timestamp: 3, toolName: 'Bash' },
  { id: 'u-real-1', role: 'user', content: 'second prompt', timestamp: 4 },
  { id: 'a-2', role: 'assistant', content: 'replying', timestamp: 5 },
  { id: 't-2', role: 'tool', content: 'ran another', timestamp: 6, toolName: 'Read' },
]

let broadcastSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  broadcastSpy = vi.fn(async () => {})
  ;(globalThis as any).window = {
    ion: {
      engineStop: vi.fn(async () => {}),
      engineStart: vi.fn(async () => ({ ok: true })),
      engineBroadcastHistory: broadcastSpy,
    },
  }
})

describe('rewindEngineInstance — target resolution', () => {
  it('resolves by id when messageId is present (desktop-initiated path)', () => {
    const { state, slice } = buildHarness(INTERLEAVED)
    // Rewind to the second user message by its real id.
    slice.rewindEngineInstance('tab1', 'inst1', 'u-real-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    // keepMsgs = index of u-real-1 (3) → first 3 messages retained.
    expect(inst.messages.map((m: any) => m.id)).toEqual(['u-real-0', 'a-1', 't-1'])
    expect(state.tabs[0].pendingInput).toBe('second prompt')
  })

  it('resolves by userTurnIndex when id is absent (iOS-initiated path), stable across interleaving', () => {
    const { state, slice } = buildHarness(INTERLEAVED)
    // iOS sends an optimistic-UUID id that does not exist, plus userTurnIndex=1
    // (the second user turn). Must resolve to u-real-1 at index 3 despite the
    // interleaved assistant/tool rows.
    slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE', 1)
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.messages.map((m: any) => m.id)).toEqual(['u-real-0', 'a-1', 't-1'])
    expect(state.tabs[0].pendingInput).toBe('second prompt')
  })

  it('resolves userTurnIndex=0 to the first user message', () => {
    const { state, slice } = buildHarness(INTERLEAVED)
    slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE', 0)
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.messages).toEqual([]) // nothing kept before the first user turn
    expect(state.tabs[0].pendingInput).toBe('first prompt')
  })

  it('no-ops when id is absent and userTurnIndex is out of range', () => {
    const { state, slice } = buildHarness(INTERLEAVED)
    const before = state.conversationPanes.get('tab1')!.instances[0].messages.length
    slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE', 99)
    expect(state.conversationPanes.get('tab1')!.instances[0].messages.length).toBe(before)
  })

  it('no-ops when id is absent and no userTurnIndex is supplied', () => {
    const { state, slice } = buildHarness(INTERLEAVED)
    const before = state.conversationPanes.get('tab1')!.instances[0].messages.length
    slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE')
    expect(state.conversationPanes.get('tab1')!.instances[0].messages.length).toBe(before)
  })
})

describe('rewindEngineInstance — broadcast after restart', () => {
  it('broadcasts truncated history to remote devices after the fresh session starts', async () => {
    const { slice } = buildHarness(INTERLEAVED)
    slice.rewindEngineInstance('tab1', 'inst1', 'u-real-1')
    // engineStop → engineStart → engineBroadcastHistory chain is async; flush.
    await new Promise((r) => setTimeout(r, 0))
    expect(broadcastSpy).toHaveBeenCalledWith('tab1', 'inst1')
  })
})

describe('rewindEngineInstance — pending-card restoration after rewind', () => {
  // History whose kept slice (everything before the rewind target) ends with a
  // pending AskUserQuestion → the card must be restored on the rewound instance.
  const ASK_THEN_TARGET = [
    { id: 'u-0', role: 'user', content: 'do a thing', timestamp: 1 },
    { id: 'a-1', role: 'assistant', content: 'thinking', timestamp: 2 },
    { id: 'q-1', role: 'assistant', content: '', timestamp: 3, toolName: 'AskUserQuestion', toolId: 'tu-q', toolInput: '{"question":"which?"}' } as any,
    { id: 'u-1', role: 'user', content: 'rewind here', timestamp: 4 },
  ]

  it('restores the AskUserQuestion card when the kept history ends with it', () => {
    const { state, slice } = buildHarness(ASK_THEN_TARGET)
    // Rewind to u-1 → keep [u-0, a-1, q-1]; that slice ends with the question.
    slice.rewindEngineInstance('tab1', 'inst1', 'u-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.permissionDenied).not.toBeNull()
    expect(inst.permissionDenied!.tools[0].toolName).toBe('AskUserQuestion')
  })

  // Same question, but a /clear divider sits between the question and the
  // rewind target → the kept slice ends with the clear, which dismisses the
  // card. Regression guard: a cleared question must NOT be resurrected.
  const ASK_THEN_CLEAR_THEN_TARGET = [
    { id: 'u-0', role: 'user', content: 'do a thing', timestamp: 1 },
    { id: 'q-1', role: 'assistant', content: '', timestamp: 2, toolName: 'AskUserQuestion', toolId: 'tu-q', toolInput: '{"question":"which?"}' } as any,
    { id: 'c-1', role: 'system', content: formatClearDivider(new Date()), timestamp: 3 },
    { id: 'u-1', role: 'user', content: 'rewind here', timestamp: 4 },
  ]

  it('does NOT restore the card when a /clear divider follows the question in the kept history', () => {
    const { state, slice } = buildHarness(ASK_THEN_CLEAR_THEN_TARGET)
    // Rewind to u-1 → keep [u-0, q-1, c-1]; the clear divider dismisses it.
    slice.rewindEngineInstance('tab1', 'inst1', 'u-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.permissionDenied).toBeNull()
  })
})
