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
    lastMessagePreview: null,
  })),
  nextMsgId: vi.fn(() => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

// Preferences store: supply enough to satisfy the auto-move guard.
// `createTabInDirectory` also calls `addRecentBaseDirectory` and
// `incrementDirectoryUsage` on the prefs store; both are no-ops here. The
// `tabGroups` list is needed by the new `pinToGroupId` describe block so
// the default-group lookup resolves to a concrete id when the caller does
// NOT supply pinToGroupId — that's the negative-control case in the test
// for default-group placement.
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
      addRecentBaseDirectory: vi.fn(),
      incrementDirectoryUsage: vi.fn(),
      defaultTallConversation: false,
      tabGroups: [
        { id: 'group-default', label: 'Default', isDefault: true, order: 0 },
        { id: 'group-planning', label: 'Planning', isDefault: false, order: 1 },
      ],
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
    lastMessagePreview: null,
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
    enginePermissionDenied: new Map(),
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
      enginePermissionDenied: new Map(),
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

// ── moveTabToGroupAndPin ─────────────────────────────────────────────────────
//
// The combined action must both:
//   1. Move the tab into the target group (same reordering as moveTabToGroup).
//   2. Set groupPinned=true in the same store update so that any subsequent
//      sendMessage's auto-movement guard (gated on !groupPinned in
//      send-slice.ts) skips this tab.
//
// We deliberately do NOT re-spy moveTabToGroup here — buildHarness does that
// for the auto-move tests above. Instead we exercise the real implementation
// on a fresh harness, then verify a follow-up sendMessage is suppressed.

describe('moveTabToGroupAndPin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
  })

  it('sets groupId and groupPinned=true atomically', () => {
    const tab = makeTab({ groupId: INTERMEDIATE_GROUP, groupPinned: false })
    const { state } = buildHarness(tab)

    state.moveTabToGroupAndPin('tab-1', PLANNING_GROUP)

    expect(state.tabs[0].groupId).toBe(PLANNING_GROUP)
    expect(state.tabs[0].groupPinned).toBe(true)
  })

  it('suppresses subsequent auto-movement in plan mode', () => {
    // Use a tab in plan mode but in a non-planning group, so that without
    // pinning, sendMessage would normally move it. After moveTabToGroupAndPin,
    // it should already be pinned and the send-slice should skip the move.
    const tab = makeTab({
      permissionMode: 'plan',
      groupId: INTERMEDIATE_GROUP,
      groupPinned: false,
    })
    const { state, moveTabToGroup } = buildHarness(tab)

    // Pin it into the planning group.
    state.moveTabToGroupAndPin('tab-1', PLANNING_GROUP)
    // Reset the spy: buildHarness overrides moveTabToGroup with a spy, but
    // the pin-aware action does not go through that spy (it sets fields
    // directly). Clear the spy so we observe only the sendMessage's
    // behaviour from this point onward.
    moveTabToGroup.mockClear()

    state.sendMessage('hello', '/home/test')

    expect(moveTabToGroup).not.toHaveBeenCalled()
    expect(state.tabs[0].groupId).toBe(PLANNING_GROUP)
    expect(state.tabs[0].groupPinned).toBe(true)
  })

  it('is a no-op for an unknown tabId', () => {
    const tab = makeTab({ groupId: INTERMEDIATE_GROUP, groupPinned: false })
    const { state } = buildHarness(tab)

    state.moveTabToGroupAndPin('nonexistent', PLANNING_GROUP)

    expect(state.tabs[0].groupId).toBe(INTERMEDIATE_GROUP)
    expect(state.tabs[0].groupPinned).toBe(false)
  })
})

// ── createTabInDirectory with pinToGroupId ───────────────────────────────────
//
// The 4th-positional pinToGroupId argument is the renderer-side foundation for
// the iOS per-group "+" button: when set in manual mode, the new tab is born
// inside that group with groupPinned=true so the very first sendMessage's
// auto-movement skips it. When omitted (or in non-manual mode), behavior is
// unchanged — the tab lands in the configured default group, unpinned.

describe('createTabInDirectory with pinToGroupId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
    // Round out the window stub with the APIs createTabInDirectory touches.
    // window.ion.createTab returns a tabId; gitIsRepo is called only when
    // useWorktree is true (we set it false), but mock it defensively.
    ;(globalThis as any).window.ion.createTab = vi.fn(async () => ({ tabId: 'new-tab-id' }))
    ;(globalThis as any).window.ion.gitIsRepo = vi.fn(async () => ({ isRepo: false }))
  })

  it('places the new tab into pinToGroupId with groupPinned=true', async () => {
    const tab = makeTab({ groupId: INTERMEDIATE_GROUP })
    const { state } = buildHarness(tab)

    const newId = await state.createTabInDirectory('/home/test/proj', false, true, PLANNING_GROUP)

    const created = state.tabs.find((t: TabState) => t.id === newId)
    expect(created).toBeDefined()
    expect(created!.groupId).toBe(PLANNING_GROUP)
    expect(created!.groupPinned).toBe(true)
  })

  it('uses default group when pinToGroupId is omitted', async () => {
    const tab = makeTab({ groupId: INTERMEDIATE_GROUP })
    const { state } = buildHarness(tab)

    const newId = await state.createTabInDirectory('/home/test/proj', false, true)

    const created = state.tabs.find((t: TabState) => t.id === newId)
    expect(created).toBeDefined()
    expect(created!.groupId).toBe('group-default')
    expect(created!.groupPinned).toBe(false)
  })

  it('suppresses subsequent auto-movement in plan mode when pinned at creation', async () => {
    const tab = makeTab({ groupId: INTERMEDIATE_GROUP })
    const { state, moveTabToGroup } = buildHarness(tab)

    const newId = await state.createTabInDirectory('/home/test/proj', false, true, PLANNING_GROUP)
    // Switch the new tab to plan mode (matches the default for fresh tabs in
    // production but our mock makeLocalTab sets it to 'auto').
    state.tabs = state.tabs.map((t: TabState) =>
      t.id === newId ? { ...t, permissionMode: 'plan' as const } : t
    )
    state.activeTabId = newId
    moveTabToGroup.mockClear()

    state.sendMessage('hello', '/home/test/proj')

    expect(moveTabToGroup).not.toHaveBeenCalled()
    const created = state.tabs.find((t: TabState) => t.id === newId)
    expect(created!.groupId).toBe(PLANNING_GROUP)
    expect(created!.groupPinned).toBe(true)
  })
})
