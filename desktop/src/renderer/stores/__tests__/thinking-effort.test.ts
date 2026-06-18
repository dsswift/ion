/**
 * thinking-effort — per-conversation thinking control tests.
 *
 * Pins:
 *   1. setThinkingEffort isolates state per-tab (bare conversation).
 *   2. sendMessage includes thinkingEffort on window.ion.prompt ONLY when the
 *      global thinkingEnabled is on AND the tab's level is non-off.
 *   3. Global off → thinkingEffort omitted even when the tab has a level.
 *
 * Reuses the send-slice-plan-mode harness pattern. The global preference is
 * mocked per-test via the usePreferencesStore mock's mutable return.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({ id: 'mock-tab' })),
  initialModelOverride: vi.fn(() => null),
  nextMsgId: vi.fn(() => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
}))

// Mutable preference state the mock reads; tests flip thinkingEnabled.
const prefState = {
  autoGroupMovement: false,
  tabGroupMode: 'manual',
  planningGroupId: 'group-planning',
  inProgressGroupId: 'group-inprogress',
  doneGroupId: 'group-done',
  preferredModel: null,
  defaultPermissionMode: 'auto' as const,
  planModelSplitEnabled: false,
  planModeModel: null,
  addRecentBaseDirectory: vi.fn(),
  incrementDirectoryUsage: vi.fn(),
  defaultTallConversation: false,
  engineProfiles: [] as unknown[],
  engineDefaultModel: null,
  tabGroups: [{ id: 'group-default', label: 'Default', isDefault: true, order: 0 }],
  thinkingEnabled: false,
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => prefState) },
}))

import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import { seedMainPane } from './helpers/conversation-test-helpers'

const mockPrompt = vi.fn(async (..._args: unknown[]) => {})
;(globalThis as any).window = {
  ion: {
    prompt: mockPrompt,
    setPermissionMode: vi.fn(),
    steer: vi.fn(),
    engineSetPlanMode: vi.fn(),
  },
  crypto: { randomUUID: () => 'uuid-1234' },
}

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1', conversationId: null, historicalSessionIds: [], lastKnownSessionId: null,
    status: 'idle', activeRequestId: null, lastEventAt: null, hasUnread: false, currentActivity: '',
    attachments: [], title: 'New Tab', customTitle: null, lastResult: null, sessionTools: [],
    sessionMcpServers: [], sessionSkills: [], sessionVersion: null, queuedPrompts: [],
    workingDirectory: '/home/test', hasChosenDirectory: true, additionalDirs: [], permissionMode: 'auto',
    bashResults: [], bashExecuting: false, bashExecId: null, pillColor: null, pillIcon: null,
    forkedFromSessionId: null, hasFileActivity: false, worktree: null, pendingWorktreeSetup: false,
    groupId: null, groupPinned: false, contextTokens: null, contextPercent: null, contextWindow: null,
    isCompacting: false, isTerminalOnly: false, hasEngineExtension: false, engineProfileId: null,
    lastMessagePreview: null, ...overrides,
  } as TabState
}

function buildHarness(initialTab: TabState) {
  const state: any = {
    tabs: [initialTab],
    activeTabId: initialTab.id,
    scrollToBottomCounter: 0,
    staticInfo: { homePath: '/home/test', projectPath: '/home/test', version: '1', email: null, subscriptionType: null },
    backend: 'api' as const,
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    worktreeUncommittedMap: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    conversationPanes: seedMainPane(initialTab.id, { permissionMode: initialTab.permissionMode }),
    engineModelFallbacks: new Map(),
    fileExplorerOpenDirs: new Set(),
    fileEditorOpenDirs: new Set(),
  }
  const set = vi.fn((updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  })
  const get = () => state as State
  const tabSlice = createTabSlice(set, get)
  const sendSlice = createSendSlice(set, get)
  Object.assign(state, tabSlice, sendSlice)
  state.moveTabToGroup = vi.fn()
  state.handleError = vi.fn()
  return { state }
}

describe('setThinkingEffort — per-conversation isolation', () => {
  beforeEach(() => { vi.clearAllMocks(); prefState.thinkingEnabled = false })

  it('writes the effort onto the active bare tab', () => {
    const { state } = buildHarness(makeTab())
    state.setThinkingEffort('high')
    expect(state.tabs.find((t: TabState) => t.id === 'tab-1')!.thinkingEffort).toBe('high')
  })

  it('off clears the level back', () => {
    const { state } = buildHarness(makeTab({ thinkingEffort: 'high' }))
    state.setThinkingEffort('off')
    expect(state.tabs.find((t: TabState) => t.id === 'tab-1')!.thinkingEffort).toBe('off')
  })
})

describe('sendMessage — thinking gating', () => {
  beforeEach(() => { vi.clearAllMocks(); mockPrompt.mockResolvedValue(undefined); prefState.thinkingEnabled = false })

  it('global ON + tab level high → thinkingEffort:high on prompt', () => {
    prefState.thinkingEnabled = true
    const { state } = buildHarness(makeTab({ thinkingEffort: 'high' }))
    state.sendMessage('hello')
    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBe('high')
  })

  it('global OFF → thinkingEffort omitted even when tab level set', () => {
    prefState.thinkingEnabled = false
    const { state } = buildHarness(makeTab({ thinkingEffort: 'high' }))
    state.sendMessage('hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBeUndefined()
  })

  it('global ON + tab level off → thinkingEffort omitted', () => {
    prefState.thinkingEnabled = true
    const { state } = buildHarness(makeTab({ thinkingEffort: 'off' }))
    state.sendMessage('hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBeUndefined()
  })
})
