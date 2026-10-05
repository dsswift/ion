/**
 * The owner saves tabs.json and publishes studio:tabs-sync on a 100ms timer
 * after a store change. While a conversation streams, the store changes
 * faster than that. A timer restarted on every change never fired then, so a
 * change made meanwhile (clearing a conversation's color) reached Studio only
 * once every stream went quiet, tens of seconds later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => ({ tabRecoveryEnabled: false }) } }))
vi.mock('../../components/TerminalInstance', () => ({ serializeTerminalBuffer: () => null }))
vi.mock('@ion/shared/tab-predicates', () => ({ tabHasExtensions: () => false }))
vi.mock('../serialize-conversation-pane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serialize-conversation-pane')>()
  return {
    ...actual,
    serializeConversationPane: () => ({
      activeInstanceId: 'main',
      instances: [{ id: 'main', label: 'main', draftInput: 'unsent', agentStates: [{ name: 'writer', status: 'done', metadata: { task: 'x'.repeat(5_000) } }] }],
    }),
  }
})
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({ attachments: [], queuedPrompts: [] })),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))
const mockSaveTabs = vi.fn().mockResolvedValue(undefined)
const mockPublish = vi.fn()
vi.mock('../host-api', () => ({
  saveTabs: (...args: unknown[]) => mockSaveTabs(...args),
  loadSessionChains: () => Promise.resolve({ chains: {}, reverse: {} }),
  saveSessionChains: () => Promise.resolve(),
  saveTabContent: vi.fn().mockResolvedValue(undefined),
  studioPublishTabsSync: (...args: unknown[]) => mockPublish(...args),
}))
vi.mock('../chart-reconcile', () => ({ reconcileConversationCharts: vi.fn() }))
vi.mock('../../state', () => ({ engineBridge: {} }))

import { setupPersistence } from '../session-store-persistence'

function tab(conversationId: string | null, pillColor: string | null = null) {
  return {
    id: 'tab1', title: 'Test', customTitle: null, workingDirectory: '/tmp', hasChosenDirectory: false, conversationId, status: 'idle',
    historicalSessionIds: [], lastKnownSessionId: null, bashResults: [], pillColor, forkedFromSessionId: null, worktree: null,
    queuedPrompts: [], attachments: [], contextTokens: 0, lastMessagePreview: null, lastEventAt: null, isTerminalOnly: false,
    additionalDirs: [], engineProfileId: null,
  }
}

function store() {
  const listeners: Array<(s: unknown, p: unknown) => void> = []
  let state: Record<string, unknown> = {
    tabs: [tab(null)], activeTabId: 'tab1', isExpanded: true, fileEditorStates: new Map(), fileEditorOpenDirs: new Set(),
    editorGeometry: null, planGeometry: null, agentDetailGeometry: null, terminalPanes: new Map(),
    conversationPanes: new Map([['tab1', { activeInstanceId: 'main', instances: [] }]]), settledHistory: [], rehydrating: false, tabsReady: false,
  }
  return {
    subscribe: (fn: (s: unknown, p: unknown) => void) => { listeners.push(fn); return () => {} },
    getState: () => state,
    setState: (patch: Record<string, unknown>) => {
      const prev = state
      state = { ...state, ...patch }
      listeners.forEach((fn) => fn(state, prev))
    },
  }
}

beforeEach(() => {
  mockSaveTabs.mockClear()
  mockPublish.mockClear()
  ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn() }
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('studio:tabs-sync cadence', () => {
  it('publishes a tab change within the save window while the store keeps changing', () => {
    const s = store()
    setupPersistence(s as never)
    s.setState({ tabs: [tab('conv-1', '#4caf50')] })
    mockPublish.mockClear()

    s.setState({ tabs: [tab('conv-1', null)] })
    // A stream: a conversation pane changes every 50ms for two seconds.
    for (let elapsed = 0; elapsed < 2_000; elapsed += 50) {
      s.setState({ conversationPanes: new Map([['tab1', { activeInstanceId: 'main', instances: [] }]]) })
      vi.advanceTimersByTime(50)
      if (elapsed === 100) {
        expect(mockPublish).toHaveBeenCalled()
        expect(mockPublish.mock.calls.at(-1)?.[0].tabs[0]).not.toHaveProperty('pillColor')
      }
    }
    // One save per window, not one per change.
    expect(mockPublish.mock.calls.length).toBeGreaterThanOrEqual(15)
    expect(mockPublish.mock.calls.length).toBeLessThanOrEqual(21)
  })
})
