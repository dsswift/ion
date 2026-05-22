/**
 * tab-group-pin — unit tests
 *
 * Verifies that `groupPinned: true` suppresses auto-group movement in
 * sendMessage and submitRemotePrompt, and that toggleTabGroupPin flips
 * the flag correctly.
 *
 * Tests are isolated: we mock window.ion, preferences, TerminalPanel, and
 * session-store-helpers so no real DOM or persistence is needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── module-level mocks ────────────────────────────────────────────────────────

// TerminalPanel is imported by tab-slice.ts at module load and accesses
// xterm APIs that don't exist in Node. Mock it before any slice imports.
vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

// session-store-helpers.ts calls `new Audio(...)` at module load.
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'mock-tab',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle' as const,
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    draftInput: '',
    messages: [],
    customTitle: null,
    lastResult: null,
    sessionModel: null,
    modelOverride: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: 'auto' as const,
    planFilePath: null,
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    hasFileActivity: false,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    contextTokens: null,
    contextPercent: null,
    isCompacting: false,
    isTerminalOnly: false,
    isEngine: false,
    engineProfileId: null,
  })),
  nextMsgId: vi.fn(() => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

// Preferences store: supply enough to satisfy the auto-move guard.
vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({
      autoGroupMovement: true,
      tabGroupMode: 'manual',
      planningGroupId: 'group-planning',
      inProgressGroupId: 'group-inprogress',
      doneGroupId: 'group-done',
      preferredModel: null,
      defaultPermissionMode: 'auto' as const,
      planModelSplitEnabled: false,
      planModeModel: null,
    })),
  },
}))

import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'

// ── global window stub ────────────────────────────────────────────────────────

const mockPrompt = vi.fn(async () => {})
const mockSetPermissionMode = vi.fn()
;(globalThis as any).window = {
  ion: {
    prompt: mockPrompt,
    setPermissionMode: mockSetPermissionMode,
  },
  crypto: { randomUUID: () => 'uuid-1234' },
}

// ── constants ─────────────────────────────────────────────────────────────────

const PLANNING_GROUP = 'group-planning'
const INPROGRESS_GROUP = 'group-inprogress'
const INTERMEDIATE_GROUP = 'group-intermediate'

// ── test state builder ────────────────────────────────────────────────────────

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    draftInput: '',
    messages: [],
    title: 'New Tab',
    customTitle: null,
    lastResult: null,
    sessionModel: null,
    modelOverride: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '/home/test',
    hasChosenDirectory: true,
    additionalDirs: [],
    permissionMode: 'plan',
    planFilePath: null,
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    hasFileActivity: false,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: INTERMEDIATE_GROUP,
    groupPinned: false,
    contextTokens: null,
    contextPercent: null,
    isCompacting: false,
    isTerminalOnly: false,
    isEngine: false,
    engineProfileId: null,
    ...overrides,
  }
}

function buildHarness(initialTab: TabState) {
  const state: any = {
    tabs: [initialTab],
    activeTabId: initialTab.id,
    scrollToBottomCounter: 0,
    staticInfo: {
      homePath: '/home/test',
      projectPath: '/home/test',
      version: '1',
      email: null,
      subscriptionType: null,
    },
    backend: 'api' as const,
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    worktreeUncommittedMap: new Map(),
    engineAgentStates: new Map(),
    engineStatusFields: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineConversationIds: new Map(),
    enginePanes: new Map(),
    engineMessages: new Map(),
    engineDraftInputs: new Map(),
    fileExplorerOpenDirs: new Set(),
    fileEditorOpenDirs: new Set(),
  }

  const set = vi.fn((updater: any) => {
    const patch = typeof updater === 'function' ? updater(state) : updater
    Object.assign(state, patch)
  })

  const get = () => state as State

  const moveTabToGroup = vi.fn((tabId: string, groupId: string) => {
    state.tabs = state.tabs.map((t: TabState) =>
      t.id === tabId ? { ...t, groupId } : t
    )
  })

  // Build slices
  const tabSlice = createTabSlice(set, get)
  const sendSlice = createSendSlice(set, get)

  Object.assign(state, tabSlice, sendSlice)
  // Override moveTabToGroup with a spy so we can assert call counts
  state.moveTabToGroup = moveTabToGroup

  return { state, moveTabToGroup, set }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('auto-move suppression when groupPinned = true', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  describe('sendMessage', () => {
    it('moves tab to planning group when groupPinned = false and mode = plan', () => {
      const tab = makeTab({ permissionMode: 'plan', groupPinned: false })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.sendMessage('hello', '/home/test')

      expect(moveTabToGroup).toHaveBeenCalledWith('tab-1', PLANNING_GROUP)
    })

    it('does NOT move tab when groupPinned = true and mode = plan', () => {
      const tab = makeTab({ permissionMode: 'plan', groupPinned: true })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.sendMessage('hello', '/home/test')

      expect(moveTabToGroup).not.toHaveBeenCalled()
    })

    it('moves tab to in-progress group when groupPinned = false and mode = auto', () => {
      const tab = makeTab({ permissionMode: 'auto', groupPinned: false })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.sendMessage('hello', '/home/test')

      expect(moveTabToGroup).toHaveBeenCalledWith('tab-1', INPROGRESS_GROUP)
    })

    it('does NOT move tab when groupPinned = true and mode = auto', () => {
      const tab = makeTab({ permissionMode: 'auto', groupPinned: true })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.sendMessage('hello', '/home/test')

      expect(moveTabToGroup).not.toHaveBeenCalled()
    })
  })

  describe('submitRemotePrompt', () => {
    it('moves tab to planning group when groupPinned = false and mode = plan', () => {
      const tab = makeTab({ permissionMode: 'plan', groupPinned: false })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.submitRemotePrompt('tab-1', 'hello')

      expect(moveTabToGroup).toHaveBeenCalledWith('tab-1', PLANNING_GROUP)
    })

    it('does NOT move tab when groupPinned = true and mode = plan', () => {
      const tab = makeTab({ permissionMode: 'plan', groupPinned: true })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.submitRemotePrompt('tab-1', 'hello')

      expect(moveTabToGroup).not.toHaveBeenCalled()
    })

    it('moves tab to in-progress group when groupPinned = false and mode = auto', () => {
      const tab = makeTab({ permissionMode: 'auto', groupPinned: false })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.submitRemotePrompt('tab-1', 'hello')

      expect(moveTabToGroup).toHaveBeenCalledWith('tab-1', INPROGRESS_GROUP)
    })

    it('does NOT move tab when groupPinned = true and mode = auto', () => {
      const tab = makeTab({ permissionMode: 'auto', groupPinned: true })
      const { state, moveTabToGroup } = buildHarness(tab)

      state.submitRemotePrompt('tab-1', 'hello')

      expect(moveTabToGroup).not.toHaveBeenCalled()
    })
  })
})

describe('toggleTabGroupPin', () => {
  it('flips groupPinned from false to true', () => {
    const tab = makeTab({ groupPinned: false })
    const { state } = buildHarness(tab)

    state.toggleTabGroupPin('tab-1')

    expect(state.tabs[0].groupPinned).toBe(true)
  })

  it('flips groupPinned from true to false', () => {
    const tab = makeTab({ groupPinned: true })
    const { state } = buildHarness(tab)

    state.toggleTabGroupPin('tab-1')

    expect(state.tabs[0].groupPinned).toBe(false)
  })

  it('does not affect other tabs', () => {
    const tab1 = makeTab({ id: 'tab-1', groupPinned: false })
    const tab2 = makeTab({ id: 'tab-2', groupPinned: true })
    const state: any = {
      tabs: [tab1, tab2],
      activeTabId: tab1.id,
      scrollToBottomCounter: 0,
      staticInfo: null,
      backend: 'api' as const,
      terminalPanes: new Map(),
      terminalOpenTabIds: new Set(),
      worktreeUncommittedMap: new Map(),
      engineAgentStates: new Map(),
      engineStatusFields: new Map(),
      engineWorkingMessages: new Map(),
      engineNotifications: new Map(),
      engineDialogs: new Map(),
      enginePinnedPrompt: new Map(),
      engineUsage: new Map(),
      engineConversationIds: new Map(),
      enginePanes: new Map(),
      engineMessages: new Map(),
      engineDraftInputs: new Map(),
      fileExplorerOpenDirs: new Set(),
      fileEditorOpenDirs: new Set(),
    }
    const set = vi.fn((updater: any) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      Object.assign(state, patch)
    })
    const get = () => state as State
    const tabSlice = createTabSlice(set, get)
    Object.assign(state, tabSlice)

    state.toggleTabGroupPin('tab-1')

    expect(state.tabs[0].groupPinned).toBe(true)
    expect(state.tabs[1].groupPinned).toBe(true) // unchanged
  })
})
