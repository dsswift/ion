/**
 * engine-slice move — unit tests
 *
 * Tests the moveEngineInstance action in isolation using a hand-built
 * set/get pair over a plain mutable State object. ConversationInstance fields
 * (messages, agentStates, etc.) travel with the instance object in conversationPanes.
 * Non-ConversationInstance compound-keyed Maps (workingMessages, notifications,
 * dialogs, pinnedPrompt, usage) are rekeyed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'mock-tab',
    title: '',
    hasEngineExtension: false,
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: false,
    pillIcon: null,
    groupId: null,
    status: 'idle',
    customTitle: null,
    pillColor: null,
  })),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineSlice } from '../slices/engine-slice'
import type { State } from '../session-store-types'
import type { ConversationRef, ConversationPane, ConversationInstance } from '../../../shared/types-engine'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTab(id: string, hasEngineExtension = true) {
  return {
    id,
    title: 'Engine',
    hasEngineExtension,
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

function makeInstance(id: string, label: string, extra?: Partial<ConversationInstance>): ConversationRef & ConversationInstance {
  return {
    id,
    label,
    messages: [],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    forkedFromConversationIds: null,
    ...extra,
  }
}

function makePane(instances: Array<ConversationRef & ConversationInstance>, activeInstanceId: string | null): ConversationPane {
  return { instances, activeInstanceId }
}

/**
 * Builds a minimal State object with an inst1 that carries populated
 * ConversationInstance fields and non-ConversationInstance compound-keyed Maps.
 */
function buildHarness() {
  const inst1 = makeInstance('inst1', 'Engine 1', {
    messages: [{ id: '1', role: 'user' as const, content: 'hi', timestamp: 1 }],
    agentStates: [{ name: 'chief', status: 'idle' }],
    statusFields: { label: 'l', state: 'idle', model: 'm', contextPercent: 0, contextWindow: 1000 },
    conversationIds: ['conv-abc'],
    permissionDenied: { tools: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } }] },
    modelOverride: 'claude-3',
    draftInput: 'draft',
    permissionMode: 'auto',
  })

  const state: any = {
    tabs: [makeTab('srcTab'), makeTab('dstTab')],
    conversationPanes: new Map([
      ['srcTab', makePane([inst1], 'inst1')],
      ['dstTab', makePane([makeInstance('inst2', 'Engine 2')], 'inst2')],
    ]),
    // Non-ConversationInstance compound-keyed Maps — these still get rekeyed.
    engineWorkingMessages: new Map([['srcTab:inst1', 'working...']]),
    engineNotifications: new Map([['srcTab:inst1', [{ id: 'n1', message: 'note', level: 'info', timestamp: 1 }]]]),
    engineDialogs: new Map([['srcTab:inst1', null]]),
    enginePinnedPrompt: new Map([['srcTab:inst1', 'pinned']]),
    engineUsage: new Map([['srcTab:inst1', { percent: 10, tokens: 100, cost: 0.01 }]]),
    engineModelFallbacks: new Map(),
    closeTab: vi.fn(),
  }

  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State

  const slice = createEngineSlice(set, get) as State
  return { state, slice }
}

// ── mock window.ion ───────────────────────────────────────────────────────────

beforeEach(() => {
  ;(globalThis as any).window = {
    ion: {
      engineRemapSession: vi.fn(),
      engineAbort: vi.fn(async () => {}),
    },
  }
})

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

// ── tests ─────────────────────────────────────────────────────────────────────

describe('moveEngineInstance', () => {
  it('ConversationInstance fields travel with the instance to the new pane', () => {
    const { state, slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const dstPane = state.conversationPanes.get('dstTab')!
    const movedInst = dstPane.instances.find((i: ConversationRef) => i.id === 'inst1')
    expect(movedInst).toBeDefined()
    // Messages travel with the instance
    expect(movedInst?.messages).toHaveLength(1)
    expect(movedInst?.messages[0].content).toBe('hi')
    // Other ConversationInstance fields travel too
    expect(movedInst?.modelOverride).toBe('claude-3')
    expect(movedInst?.draftInput).toBe('draft')
    expect(movedInst?.conversationIds).toEqual(['conv-abc'])
    expect(movedInst?.permissionDenied?.tools[0].toolName).toBe('AskUserQuestion')
    expect(movedInst?.statusFields?.state).toBe('idle')
  })

  it('non-ConversationInstance compound-keyed Maps are rekeyed', () => {
    const { state, slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const newKey = 'dstTab:inst1'
    const oldKey = 'srcTab:inst1'

    // New key present in the remaining Maps
    expect(state.engineWorkingMessages.has(newKey)).toBe(true)
    expect(state.engineNotifications.has(newKey)).toBe(true)
    expect(state.engineDialogs.has(newKey)).toBe(true)
    expect(state.enginePinnedPrompt.has(newKey)).toBe(true)
    expect(state.engineUsage.has(newKey)).toBe(true)

    // Old key absent
    expect(state.engineWorkingMessages.has(oldKey)).toBe(false)
    expect(state.engineNotifications.has(oldKey)).toBe(false)
    expect(state.engineDialogs.has(oldKey)).toBe(false)
    expect(state.enginePinnedPrompt.has(oldKey)).toBe(false)
    expect(state.engineUsage.has(oldKey)).toBe(false)

    // Values were transferred
    expect(state.enginePinnedPrompt.get(newKey)).toBe('pinned')
  })

  it('adds moved instance to target pane and sets activeInstanceId', () => {
    const { state, slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const dstPane = state.conversationPanes.get('dstTab')!
    expect(dstPane.instances.map((i: ConversationRef) => i.id)).toContain('inst1')
    expect(dstPane.activeInstanceId).toBe('inst1')
  })

  it('closes source tab and removes its pane when last instance is moved', () => {
    const { state, slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    expect(state.conversationPanes.has('srcTab')).toBe(false)
    expect(state.closeTab).toHaveBeenCalledWith('srcTab')
  })

  it('keeps source tab with updated activeInstanceId when other instances remain', () => {
    const { state, slice } = buildHarness()
    state.conversationPanes.set('srcTab', makePane(
      [makeInstance('inst1', 'Engine 1'), makeInstance('inst3', 'Engine 3')],
      'inst1',
    ))

    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const srcPane = state.conversationPanes.get('srcTab')!
    expect(srcPane.instances.map((i: ConversationRef) => i.id)).toEqual(['inst3'])
    expect(srcPane.activeInstanceId).toBe('inst3')
    expect(state.closeTab).not.toHaveBeenCalled()
  })

  it('updates activeInstanceId to last remaining when active instance is moved', () => {
    const { state, slice } = buildHarness()
    state.conversationPanes.set('srcTab', makePane(
      [makeInstance('inst1', 'Engine 1'), makeInstance('inst4', 'Engine 4')],
      'inst1',
    ))

    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const srcPane = state.conversationPanes.get('srcTab')!
    expect(srcPane.activeInstanceId).toBe('inst4')
  })

  it('calls window.ion.engineRemapSession with correct keys', () => {
    const { slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    expect((globalThis as any).window.ion.engineRemapSession)
      .toHaveBeenCalledOnce()
    expect((globalThis as any).window.ion.engineRemapSession)
      .toHaveBeenCalledWith('srcTab:inst1', 'dstTab:inst1')
  })

  it('is a no-op when source pane does not exist', () => {
    const { state, slice } = buildHarness()
    const snapshotTabs = [...state.tabs]

    slice.moveEngineInstance('nonExistentTab', 'inst1', 'dstTab')

    expect(state.tabs).toEqual(snapshotTabs)
    expect((globalThis as any).window.ion.engineRemapSession).not.toHaveBeenCalled()
  })

  it('is a no-op when target tab is not an engine tab', () => {
    const { state, slice } = buildHarness()
    state.tabs.push(makeTab('nonEngineTab', false))
    state.conversationPanes.set('nonEngineTab', makePane([], null))

    const srcPaneBefore = state.conversationPanes.get('srcTab')!.instances.length

    slice.moveEngineInstance('srcTab', 'inst1', 'nonEngineTab')

    expect(state.conversationPanes.get('srcTab')!.instances.length).toBe(srcPaneBefore)
    expect((globalThis as any).window.ion.engineRemapSession).not.toHaveBeenCalled()
  })

  it('is a no-op when instance is not in source pane', () => {
    const { state, slice } = buildHarness()
    const dstPaneBefore = state.conversationPanes.get('dstTab')!.instances.length

    slice.moveEngineInstance('srcTab', 'ghostInst', 'dstTab')

    expect(state.conversationPanes.get('dstTab')!.instances.length).toBe(dstPaneBefore)
    expect((globalThis as any).window.ion.engineRemapSession).not.toHaveBeenCalled()
  })

  it('handles move to a target with no existing pane (creates pane)', () => {
    const { state, slice } = buildHarness()
    state.conversationPanes.delete('dstTab')

    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const newPane = state.conversationPanes.get('dstTab')
    expect(newPane).toBeDefined()
    expect(newPane!.instances.map((i: ConversationRef) => i.id)).toContain('inst1')
    expect(newPane!.activeInstanceId).toBe('inst1')
  })
})
