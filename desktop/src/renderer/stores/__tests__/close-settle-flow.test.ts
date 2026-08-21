import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: () => ({ id: 'replacement', title: 'New conversation' }),
  isReusableBlankConversationTab: () => false,
  initialModelOverride: () => null,
  initialPermissionMode: () => 'auto',
  initialThinkingEffort: () => 'off',
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      engineProfiles: [],
      tabGroups: [],
      tabGroupMode: 'off',
      stashedManualTabAssignments: {},
      setStashedManualGroups: vi.fn(),
    }),
  },
  getEffectiveTabGroups: (groups: unknown) => groups,
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createCloseIntentSlice } from '../slices/close-intent-slice'
import { createInboxSlice } from '../slices/inbox-slice'
import { createTabSlice } from '../slices/tab-slice'
import { usePreferencesStore } from '../../preferences'
import type { State, StoreGet, StoreSet } from '../session-store-types'

const stopEngine = vi.fn()
const closeTabRpc = vi.fn()
const deleteTabContent = vi.fn()
const deleteStoredConversations = vi.fn()
const fsExists = vi.fn()

function durableTab(id: string) {
  return {
    id,
    title: 'Plan review',
    customTitle: null,
    workingDirectory: '/repo',
    status: 'idle',
    lastMessageAt: 1,
    conversationId: `conversation-${id}`,
    lastKnownSessionId: null,
    historicalSessionIds: [],
    isTerminalOnly: false,
    worktree: null,
    pinnedAt: null,
    pinOrderKey: null,
  }
}

function plainTab(id: string) {
  return {
    ...durableTab(id),
    lastMessageAt: null,
    conversationId: null,
    title: 'Other conversation',
  }
}

function pane(overrides: Record<string, unknown> = {}) {
  return {
    activeInstanceId: 'main',
    instances: [{
      id: 'main',
      messages: [],
      messageCount: 0,
      statusFields: { state: 'idle' },
      agentStates: [],
      permissionQueue: [],
      elicitationQueue: [],
      permissionDenied: null,
      planFilePath: null,
      ...overrides,
    }],
  }
}

function buildHarness(instance: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = {
    tabs: [durableTab('close-me'), plainTab('next-tab')],
    settledHistory: [],
    activeTabId: 'close-me',
    conversationPanes: new Map([
      ['close-me', pane(instance)],
      ['next-tab', pane()],
    ]),
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    fileExplorerOpenDirs: new Set(),
    fileEditorOpenDirs: new Set(),
    suspendedTallTabId: null,
    closeIntent: null,
    selectTab: vi.fn((tabId: string) => { state.activeTabId = tabId }),
    loadSkeletonMessages: vi.fn().mockResolvedValue(undefined),
  }
  const set = ((patch: unknown) => {
    const next = typeof patch === 'function'
      ? (patch as (current: Record<string, unknown>) => Record<string, unknown>)(state)
      : patch as Record<string, unknown>
    state = { ...state, ...next }
  }) as StoreSet
  const get = (() => state) as unknown as StoreGet
  const actions = {
    ...createTabSlice(set, get),
    ...createCloseIntentSlice(set, get),
    ...createInboxSlice(set, get),
  }
  state = { ...state, ...actions }
  return {
    get state() { return state as unknown as State },
    requestCloseTab: () => (state.requestCloseTab as (id: string) => Promise<void>)('close-me'),
    confirmCloseTab: () => (state.confirmCloseTab as () => void)(),
    settleTab: () => (state.settleTab as (id: string) => Promise<void>)('close-me'),
    autoSettleTab: () => (state.autoSettleTab as (id: string) => Promise<void>)('close-me'),
    restoreSettledHistoryTab: () => (state.restoreSettledHistoryTab as (id: string) => Promise<boolean>)('close-me'),
    unsettleTab: () => (state.unsettleTab as (id: string, reason: 'user') => Promise<boolean>)('close-me', 'user'),
    selectTab: (tabId: string) => (state.selectTab as (id: string) => void)(tabId),
    closeTab: () => (state.closeTab as (id: string) => void)('close-me'),
  }
}

beforeEach(() => {
  usePreferencesStore.getState = () => ({
    engineProfiles: [],
    inboxAutoSettleDays: 3,
    tabGroups: [],
    tabGroupMode: 'off',
    stashedManualTabAssignments: {},
    setStashedManualGroups: vi.fn(),
  }) as never
  stopEngine.mockReset().mockResolvedValue(undefined)
  closeTabRpc.mockReset().mockResolvedValue(undefined)
  deleteTabContent.mockReset().mockResolvedValue(undefined)
  deleteStoredConversations.mockReset().mockResolvedValue(undefined)
  fsExists.mockReset().mockResolvedValue({ exists: true })
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      engineStop: stopEngine,
      closeTab: closeTabRpc,
      deleteTabContent,
      deleteStoredConversations,
      terminalDestroy: vi.fn().mockResolvedValue(undefined),
      gitWorktreeAppraise: vi.fn(),
      fsExists,
    },
  }
})

describe('close and manual settle', () => {
  it('automatically settles an idle conversation with the same hard lock', async () => {
    const harness = buildHarness({
      messages: [{ id: 'm1', role: 'user', content: 'Park this later', timestamp: 1 }],
      messageCount: 1,
      historyHydrated: true,
    })
    const tab = harness.state.tabs.find((candidate) => candidate.id === 'close-me')!
    tab.lastMessageAt = Date.now() - 4 * 24 * 60 * 60 * 1000
    await harness.autoSettleTab()

    expect(stopEngine).toHaveBeenCalledWith('close-me')
    expect(harness.state.settledHistory[0]).toMatchObject({
      settledOverride: 'auto', inputLocked: true, inputLockReason: 'settled',
    })
  })

  it('refuses automatic settlement when a plan is pending', async () => {
    const harness = buildHarness({ planFilePath: '/plans/ready.md' })
    const tab = harness.state.tabs.find((candidate) => candidate.id === 'close-me')!
    tab.lastMessageAt = Date.now() - 4 * 24 * 60 * 60 * 1000
    await harness.autoSettleTab()

    expect(stopEngine).not.toHaveBeenCalled()
    expect(harness.state.settledHistory).toEqual([])
  })

  it('settles a confirmed close with a pending plan decision', async () => {
    const harness = buildHarness({
      planFilePath: '/plans/ready.md',
      permissionDenied: { tools: [{ toolName: 'ExitPlanMode' }] },
    })

    await harness.requestCloseTab()
    harness.confirmCloseTab()
    await vi.waitFor(() => expect(harness.state.settledHistory).toHaveLength(1))

    expect(stopEngine).toHaveBeenCalledWith('close-me')
    expect(harness.state.tabs.map((tab) => tab.id)).toEqual(['next-tab'])
    expect(harness.state.settledHistory[0]).toMatchObject({
      id: 'close-me',
      settledOverride: 'settled',
      inputLocked: true,
      inputLockReason: 'settled',
    })
  })

  it('permanently removes an empty tab when the user closes it', async () => {
    const harness = buildHarness({ messages: [], messageCount: 0 })
    const empty = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    empty.lastMessageAt = null

    await harness.requestCloseTab()
    harness.confirmCloseTab()
    await vi.waitFor(() => expect(closeTabRpc).toHaveBeenCalledWith('close-me'))

    expect(stopEngine).not.toHaveBeenCalled()
    expect(deleteStoredConversations).toHaveBeenCalledWith(['conversation-close-me'])
    expect(closeTabRpc).toHaveBeenCalledWith('close-me')
    expect(deleteTabContent).toHaveBeenCalledWith('close-me')
    expect(harness.state.tabs.map((tab) => tab.id)).toEqual(['next-tab'])
    expect(harness.state.settledHistory).toEqual([])
  })

  it('permanently removes an empty tab when the user settles it', async () => {
    const harness = buildHarness({ messages: [], messageCount: 0 })
    const empty = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    empty.lastMessageAt = null

    await harness.settleTab()
    await vi.waitFor(() => expect(closeTabRpc).toHaveBeenCalledWith('close-me'))

    expect(stopEngine).not.toHaveBeenCalled()
    expect(deleteStoredConversations).toHaveBeenCalledWith(['conversation-close-me'])
    expect(closeTabRpc).toHaveBeenCalledWith('close-me')
    expect(deleteTabContent).toHaveBeenCalledWith('close-me')
    expect(harness.state.tabs.map((tab) => tab.id)).toEqual(['next-tab'])
    expect(harness.state.settledHistory).toEqual([])
  })

  it('permanently removes a tab whose only row is the session-start divider', async () => {
    // Every conversation tab is born with a `── Session started at <time> ──`
    // system divider (engine-slice-create.ts). Counting it as a message filed
    // untouched tabs into Settled History with nothing to review.
    const harness = buildHarness({
      messages: [{ id: 'm1', role: 'system', content: '── Session started at 9:07 AM ──', timestamp: 1 }],
      messageCount: 1,
      historyHydrated: true,
    })
    const untouched = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    untouched.lastMessageAt = null

    await harness.settleTab()
    await vi.waitFor(() => expect(closeTabRpc).toHaveBeenCalledWith('close-me'))

    expect(stopEngine).not.toHaveBeenCalled()
    expect(harness.state.settledHistory).toEqual([])
  })

  it('settles a conversation that carries a real message beside the divider', async () => {
    const harness = buildHarness({
      messages: [
        { id: 'm1', role: 'system', content: '── Session started at 9:07 AM ──', timestamp: 1 },
        { id: 'm2', role: 'user', content: 'Fix the settle gate', timestamp: 2 },
      ],
      messageCount: 2,
    })
    const touched = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    touched.lastMessageAt = null

    await harness.settleTab()

    expect(stopEngine).toHaveBeenCalledWith('close-me')
    expect(harness.state.settledHistory.map((tab) => tab.id)).toEqual(['close-me'])
  })

  it('hydrates a restored skeleton before deciding it is empty', async () => {
    // A restored tab holds a persisted count, not rows, and that count includes
    // the divider. Settle must load the real scrollback before it decides.
    const harness = buildHarness({ messages: [], messageCount: 1, historyHydrated: false })
    const skeleton = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    skeleton.lastMessageAt = null
    ;(harness.state as unknown as Record<string, unknown>).loadSkeletonMessages = vi.fn(async () => {
      const pane = harness.state.conversationPanes.get('close-me')!
      pane.instances[0].messages = [
        { id: 'm1', role: 'system', content: '── Session started at 9:07 AM ──', timestamp: 1 },
      ] as never
      pane.instances[0].historyHydrated = true as never
    })

    await harness.settleTab()
    await vi.waitFor(() => expect(closeTabRpc).toHaveBeenCalledWith('close-me'))

    expect(harness.state.loadSkeletonMessages).toHaveBeenCalledWith('close-me')
    expect(stopEngine).not.toHaveBeenCalled()
    expect(harness.state.settledHistory).toEqual([])
  })

  it('does not treat an unhydrated conversation as empty', async () => {
    const harness = buildHarness({ messages: [], messageCount: 2, historyHydrated: false })
    const skeleton = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    skeleton.lastMessageAt = null

    await harness.settleTab()

    expect(stopEngine).toHaveBeenCalledWith('close-me')
    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(harness.state.settledHistory.map((tab) => tab.id)).toEqual(['close-me'])
  })

  it('does not delete when the pane is missing and emptiness is unknown', async () => {
    const harness = buildHarness()
    const tab = harness.state.tabs.find((candidate) => candidate.id === 'close-me')!
    tab.lastMessageAt = null
    harness.state.conversationPanes.delete('close-me')

    await harness.settleTab()

    expect(stopEngine).toHaveBeenCalledWith('close-me')
    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(harness.state.settledHistory.map((record) => record.id)).toEqual(['close-me'])
  })

  it('manually settles pending permission and elicitation decisions', async () => {
    const harness = buildHarness({
      permissionQueue: [{ questionId: 'permission-1' }],
      elicitationQueue: [{ questionId: 'elicitation-1' }],
    })

    await harness.settleTab()

    expect(stopEngine).toHaveBeenCalledWith('close-me')
    expect(harness.state.settledHistory.map((tab) => tab.id)).toEqual(['close-me'])
  })

  it('restores the selected settled record rather than selecting a different active tab', async () => {
    const harness = buildHarness()
    await harness.settleTab()

    await harness.restoreSettledHistoryTab()

    expect(harness.state.activeTabId).toBe('close-me')
    expect(harness.state.tabs.map((tab) => tab.id)).toContain('close-me')
    expect(harness.state.settledHistory.map((tab) => tab.id)).not.toContain('close-me')
  })

  it('returns a settled review tab to history when the user navigates away', async () => {
    const harness = buildHarness()
    await harness.settleTab()

    await harness.restoreSettledHistoryTab()
    expect(harness.state.tabs.map((tab) => tab.id)).toContain('close-me')
    expect(harness.state.settledHistory).toEqual([])

    harness.selectTab('next-tab')
    expect(harness.state.tabs.map((tab) => tab.id)).toEqual(['next-tab'])
    expect(harness.state.settledHistory.map((tab) => tab.id)).toEqual(['close-me'])
  })

  it('keeps a retired-worktree record forever settled', async () => {
    const harness = buildHarness()
    const source = harness.state.tabs.find((tab) => tab.id === 'close-me')!
    source.workingDirectory = '/worktrees/retired'
    source.worktree = {
      repoPath: '/repo',
      worktreePath: '/worktrees/retired',
      branchName: 'wt/retired',
      sourceBranch: 'main',
    }
    await harness.settleTab()
    fsExists.mockResolvedValue({ exists: false })

    expect(await harness.restoreSettledHistoryTab()).toBe(false)
    await harness.unsettleTab()

    expect(harness.state.tabs.map((tab) => tab.id)).not.toContain('close-me')
    expect(harness.state.settledHistory.map((tab) => tab.id)).toContain('close-me')
  })

  it('retains the active conversation when the engine cannot stop', async () => {
    stopEngine.mockRejectedValueOnce(new Error('engine stop failed'))
    const harness = buildHarness({ planFilePath: '/plans/ready.md' })

    await harness.settleTab()

    expect(harness.state.tabs.map((tab) => tab.id)).toContain('close-me')
    expect(harness.state.settledHistory).toEqual([])
  })
})
