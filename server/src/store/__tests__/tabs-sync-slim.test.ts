/**
 * tabs.json keeps each conversation's sub-agent roster so a restart restores
 * it. The studio:tabs-sync push built from the same data must not carry it:
 * no client reads it there, and on a server with many dispatches it was most
 * of a push resent to every client on every tab change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function tab(conversationId: string | null) {
  return {
    id: 'tab1', title: 'Test', customTitle: null, workingDirectory: '/tmp', hasChosenDirectory: false, conversationId, status: 'idle',
    historicalSessionIds: [], lastKnownSessionId: null, bashResults: [], pillColor: null, forkedFromSessionId: null, worktree: null,
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
})

describe('studio:tabs-sync payload', () => {
  it('saves the sub-agent roster to disk and leaves it out of the push', () => {
    const s = store()
    setupPersistence(s as never)
    // A captured conversationId persists immediately rather than on the debounce.
    s.setState({ tabs: [tab('conv-1')] })

    const saved = mockSaveTabs.mock.calls.at(-1)?.[0]
    expect(saved.tabs[0].conversationPane.instances[0].agentStates).toHaveLength(1)

    const pushed = mockPublish.mock.calls.at(-1)?.[0]
    expect(pushed.tabs[0].conversationPane.instances[0]).not.toHaveProperty('agentStates')
    expect(pushed.tabs[0].conversationPane.instances[0].draftInput).toBe('unsent')
  })
})
