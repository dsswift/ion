/**
 * engine-slice move — unit tests
 *
 * Tests the moveEngineInstance action in isolation using a hand-built
 * set/get pair over a plain mutable State object. This avoids importing
 * sessionStore.ts (which touches window and persistence at module load).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// session-store-helpers.ts calls `new Audio(...)` at module load (node env has no Audio).
// Mock the whole helpers module before the slice is imported.
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'mock-tab',
    title: '',
    isEngine: false,
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
import type { EngineInstance, EnginePaneState } from '../../../shared/types-engine'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTab(id: string, isEngine = true) {
  return {
    id,
    title: 'Engine',
    isEngine,
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

function makeInstance(id: string, label: string): EngineInstance {
  return { id, label }
}

function makePane(instances: EngineInstance[], activeInstanceId: string | null): EnginePaneState {
  return { instances, activeInstanceId }
}

/**
 * Builds a minimal State object wired to a slice that can actually mutate it.
 * Returns the state reference and the bound moveEngineInstance action.
 */
function buildHarness() {
  // Mutable state bag
  const state: any = {
    tabs: [
      makeTab('srcTab'),
      makeTab('dstTab'),
    ],
    enginePanes: new Map([
      ['srcTab', makePane([makeInstance('inst1', 'Engine 1')], 'inst1')],
      ['dstTab', makePane([makeInstance('inst2', 'Engine 2')], 'inst2')],
    ]),
    engineMessages: new Map([['srcTab:inst1', [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }]]]),
    engineAgentStates: new Map([['srcTab:inst1', [{ name: 'chief', status: 'idle' }]]]),
    engineStatusFields: new Map([['srcTab:inst1', { label: 'l', state: 'idle', model: 'm', contextPercent: 0, contextWindow: 1000 }]]),
    engineWorkingMessages: new Map([['srcTab:inst1', 'working...']]),
    engineNotifications: new Map([['srcTab:inst1', [{ id: 'n1', message: 'note', level: 'info', timestamp: 1 }]]]),
    engineDialogs: new Map([['srcTab:inst1', null]]),
    enginePinnedPrompt: new Map([['srcTab:inst1', 'pinned']]),
    engineUsage: new Map([['srcTab:inst1', { percent: 10, tokens: 100, cost: 0.01 }]]),
    engineDraftInputs: new Map([['srcTab:inst1', 'draft']]),
    engineModelOverrides: new Map([['srcTab:inst1', 'claude-3']]),
    engineConversationIds: new Map([['srcTab:inst1', ['conv-abc']]]),
    enginePermissionDenied: new Map([['srcTab:inst1', { tools: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'q?' } }] }]]),
    closeTab: vi.fn(),
  }

  // set: merges partial into state
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State

  const slice = createEngineSlice(set, get) as State
  return { state, slice }
}

// ── mock window.ion ───────────────────────────────────────────────────────────

// In vitest node env, `window` is undefined by default.
// Define it as a plain global before each test.
beforeEach(() => {
  ;(globalThis as any).window = {
    ion: {
      engineRemapSession: vi.fn(),
      engineAbort: vi.fn(async () => {}),
    },
  }
})

// ── mock usePreferencesStore ──────────────────────────────────────────────────

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
  it('migrates state across all 12 compound-keyed Maps', () => {
    const { state, slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const newKey = 'dstTab:inst1'
    const oldKey = 'srcTab:inst1'

    // New key present in every map
    expect(state.engineMessages.has(newKey)).toBe(true)
    expect(state.engineAgentStates.has(newKey)).toBe(true)
    expect(state.engineStatusFields.has(newKey)).toBe(true)
    expect(state.engineWorkingMessages.has(newKey)).toBe(true)
    expect(state.engineNotifications.has(newKey)).toBe(true)
    expect(state.engineDialogs.has(newKey)).toBe(true)
    expect(state.enginePinnedPrompt.has(newKey)).toBe(true)
    expect(state.engineUsage.has(newKey)).toBe(true)
    expect(state.engineDraftInputs.has(newKey)).toBe(true)
    expect(state.engineModelOverrides.has(newKey)).toBe(true)
    expect(state.engineConversationIds.has(newKey)).toBe(true)
    expect(state.enginePermissionDenied.has(newKey)).toBe(true)

    // Old key absent from every map
    expect(state.engineMessages.has(oldKey)).toBe(false)
    expect(state.engineAgentStates.has(oldKey)).toBe(false)
    expect(state.engineStatusFields.has(oldKey)).toBe(false)
    expect(state.engineWorkingMessages.has(oldKey)).toBe(false)
    expect(state.engineNotifications.has(oldKey)).toBe(false)
    expect(state.engineDialogs.has(oldKey)).toBe(false)
    expect(state.enginePinnedPrompt.has(oldKey)).toBe(false)
    expect(state.engineUsage.has(oldKey)).toBe(false)
    expect(state.engineDraftInputs.has(oldKey)).toBe(false)
    expect(state.engineModelOverrides.has(oldKey)).toBe(false)
    expect(state.engineConversationIds.has(oldKey)).toBe(false)
    expect(state.enginePermissionDenied.has(oldKey)).toBe(false)

    // Values were actually transferred
    expect(state.engineModelOverrides.get(newKey)).toBe('claude-3')
    expect(state.enginePinnedPrompt.get(newKey)).toBe('pinned')
    const msgs = state.engineMessages.get(newKey)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('hi')
  })

  it('adds moved instance to target pane and sets activeInstanceId', () => {
    const { state, slice } = buildHarness()
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const dstPane = state.enginePanes.get('dstTab')!
    expect(dstPane.instances.map((i: EngineInstance) => i.id)).toContain('inst1')
    expect(dstPane.activeInstanceId).toBe('inst1')
  })

  it('closes source tab and removes its pane when last instance is moved', () => {
    const { state, slice } = buildHarness()
    // srcTab has only inst1
    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    expect(state.enginePanes.has('srcTab')).toBe(false)
    expect(state.closeTab).toHaveBeenCalledWith('srcTab')
  })

  it('keeps source tab with updated activeInstanceId when other instances remain', () => {
    const { state, slice } = buildHarness()
    // Give srcTab two instances
    state.enginePanes.set('srcTab', makePane(
      [makeInstance('inst1', 'Engine 1'), makeInstance('inst3', 'Engine 3')],
      'inst1',
    ))

    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const srcPane = state.enginePanes.get('srcTab')!
    expect(srcPane.instances.map((i: EngineInstance) => i.id)).toEqual(['inst3'])
    expect(srcPane.activeInstanceId).toBe('inst3')
    expect(state.closeTab).not.toHaveBeenCalled()
  })

  it('updates activeInstanceId to last remaining when active instance is moved', () => {
    const { state, slice } = buildHarness()
    state.enginePanes.set('srcTab', makePane(
      [makeInstance('inst1', 'Engine 1'), makeInstance('inst4', 'Engine 4')],
      'inst1', // inst1 is active
    ))

    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const srcPane = state.enginePanes.get('srcTab')!
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

    // State unchanged
    expect(state.tabs).toEqual(snapshotTabs)
    expect((globalThis as any).window.ion.engineRemapSession).not.toHaveBeenCalled()
  })

  it('is a no-op when target tab is not an engine tab', () => {
    const { state, slice } = buildHarness()
    state.tabs.push(makeTab('nonEngineTab', false))
    state.enginePanes.set('nonEngineTab', makePane([], null))

    const srcPaneBefore = state.enginePanes.get('srcTab')!.instances.length

    slice.moveEngineInstance('srcTab', 'inst1', 'nonEngineTab')

    expect(state.enginePanes.get('srcTab')!.instances.length).toBe(srcPaneBefore)
    expect((globalThis as any).window.ion.engineRemapSession).not.toHaveBeenCalled()
  })

  it('is a no-op when instance is not in source pane', () => {
    const { state, slice } = buildHarness()
    const dstPaneBefore = state.enginePanes.get('dstTab')!.instances.length

    slice.moveEngineInstance('srcTab', 'ghostInst', 'dstTab')

    expect(state.enginePanes.get('dstTab')!.instances.length).toBe(dstPaneBefore)
    expect((globalThis as any).window.ion.engineRemapSession).not.toHaveBeenCalled()
  })

  it('handles move to a target with no existing pane (creates pane)', () => {
    const { state, slice } = buildHarness()
    // Remove the dstTab pane so it starts empty
    state.enginePanes.delete('dstTab')

    slice.moveEngineInstance('srcTab', 'inst1', 'dstTab')

    const newPane = state.enginePanes.get('dstTab')
    expect(newPane).toBeDefined()
    expect(newPane!.instances.map((i: EngineInstance) => i.id)).toContain('inst1')
    expect(newPane!.activeInstanceId).toBe('inst1')
  })
})
