/**
 * implementPlan — the single plan-approval → implementation pipeline
 * (implement-slice.ts). Formerly runHandleImplement, a component helper that
 * executed in whichever window hosted the card; as a store action it is
 * owner-executed everywhere (the ATV mirror forwards it — see
 * shared/atv-mirror-actions.ts).
 *
 * Pinned contracts:
 *  - Plan-mode stale-parent regression: implement must flip the AUTHORITATIVE
 *    permission mode to 'auto' so the next submit() cannot re-assert plan.
 *  - Explicit-tab regression (the ATV wrong-tab flip): the mode flip targets
 *    the CARD'S tab, not the store's activeTabId. The old pipeline called the
 *    active-tab-bound setPermissionMode; a forwarded ATV call then flipped
 *    whatever tab was active in the owner window.
 *  - Unpin ordering (Implement and Unpin): the pin is released inside the
 *    action BEFORE the auto-move pin check, so the in-progress move runs.
 *    The old pipeline forwarded the unpin cross-window and read the stale
 *    mirror pin state, suppressing the move ("moved to Planning" bug).
 *  - clearContext branch: session reset + conversationId archive + cut tag.
 *
 * The harness composes the REAL tab/send/implement slices over a manual
 * store so setPermissionMode routing and effectivePermissionMode run for real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── module-level mocks ────────────────────────────────────────────────────────

vi.mock('../../components/TerminalPanel', () => ({ destroyTerminalInstance: vi.fn() }))

// session-store-helpers constructs `new Audio()` at module load; stub the
// helpers the slices actually use so importing send-slice/tab-slice doesn't
// touch the DOM Audio API under jsdom-less test env.
vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => `msg-${Math.random()}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
  makeLocalTab: vi.fn(),
  initialModelOverride: vi.fn(() => null),
  initialPermissionMode: vi.fn(() => 'auto'),
}))

// Mutable prefs so individual tests can enable auto-group movement.
const prefs: Record<string, unknown> = {}
function resetPrefs(): void {
  Object.keys(prefs).forEach((k) => delete prefs[k])
  Object.assign(prefs, {
    autoGroupMovement: false,
    tabGroupMode: 'manual',
    planningGroupId: 'group-planning',
    inProgressGroupId: 'group-inprogress',
    doneGroupId: 'group-done',
    preferredModel: null,
    defaultPermissionMode: 'auto' as const,
    planModelSplitEnabled: false,
    planModeModel: null,
    implementModeModel: null,
    thinkingEnabled: false,
    engineProfiles: [],
    engineDefaultModel: null,
    tabGroups: [{ id: 'group-default', label: 'Default', isDefault: true, order: 0 }],
  })
}
resetPrefs()
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => prefs) },
}))

// The harness store is created per-test; this holder lets the sessionStore
// mock forward getState/setState to whichever harness the current test built.
const storeHolder: { current: any } = { current: null }
vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => storeHolder.current,
    setState: (updater: any) => {
      const patch = typeof updater === 'function' ? updater(storeHolder.current) : updater
      Object.assign(storeHolder.current, patch)
    },
  },
}))

import { createImplementSlice } from '../slices/implement-slice'
import { createSendSlice } from '../slices/send-slice'
import { createTabSlice } from '../slices/tab-slice'
import { effectivePermissionMode } from '../conversation-instance'
import type { State } from '../session-store-types'
import type { TabState } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import { seedMainPane } from './helpers/conversation-test-helpers'

// ── global window stub ────────────────────────────────────────────────────────

const mockPrompt = vi.fn(async () => {})
const mockSetPermissionMode = vi.fn()
const mockEngineSetPlanMode = vi.fn()
const mockSteer = vi.fn()
const mockReadPlan = vi.fn(async () => ({ content: '# plan body' }))
const mockResetTabSession = vi.fn()
;(globalThis as any).window = {
  ion: {
    prompt: mockPrompt,
    setPermissionMode: mockSetPermissionMode,
    engineSetPlanMode: mockEngineSetPlanMode,
    steer: mockSteer,
    readPlan: mockReadPlan,
    resetTabSession: mockResetTabSession,
  },
  crypto: { randomUUID: () => 'uuid-1234' },
}

// ── test state builder ────────────────────────────────────────────────────────

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'completed',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    title: 'New Tab',
    customTitle: null,
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '/home/test',
    hasChosenDirectory: true,
    additionalDirs: [],
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
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    engineProfileId: null,
    lastMessagePreview: null,
    ...overrides,
  }
}

function buildHarness(
  initialTabs: TabState | TabState[],
  instanceOverrides: Partial<ConversationInstance> = {},
  activeTabId?: string,
) {
  const tabs = Array.isArray(initialTabs) ? initialTabs : [initialTabs]
  const panes = seedMainPane(tabs[0].id, { permissionMode: 'auto', ...instanceOverrides })
  for (const t of tabs.slice(1)) {
    for (const [k, v] of seedMainPane(t.id, {})) panes.set(k, v)
  }
  const state: any = {
    tabs,
    activeTabId: activeTabId ?? tabs[0].id,
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
    conversationPanes: panes,
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
  const implementSlice = createImplementSlice(set, get)
  Object.assign(state, tabSlice, sendSlice, implementSlice)
  state.moveTabToGroup = vi.fn()
  state.handleError = vi.fn()
  state.addEngineSystemMessage = vi.fn()
  state.setTabModel = vi.fn()

  storeHolder.current = state
  return { state, set }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('implementPlan — plan-mode flip (plain tab)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPrefs()
    mockPrompt.mockResolvedValue(undefined)
    mockReadPlan.mockResolvedValue({ content: '# plan body' })
  })

  it('clears the AUTHORITATIVE permission mode to auto and never re-asserts plan', async () => {
    const tab = makeTab()
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: '/plans/test.md' })

    await state.implementPlan('tab-1', {})

    // Authoritative mode is on the active instance; must be 'auto' after implement.
    const resolvedTab = state.tabs.find((t: TabState) => t.id === 'tab-1')!
    expect(effectivePermissionMode(resolvedTab, state.conversationPanes)).toBe('auto')

    // The engine was told auto (plan-off). The downstream submit() prompt_sync
    // must NOT have re-asserted plan: every setPermissionMode call for this tab
    // is 'auto', never 'plan'.
    const tabCalls = mockSetPermissionMode.mock.calls.filter((c) => c[0] === 'tab-1')
    expect(tabCalls.length).toBeGreaterThan(0)
    for (const c of tabCalls) {
      expect(c[1]).toBe('auto')
    }
  })

  it('REGRESSION: flips the mode of the CARD tab even when another tab is active', async () => {
    // The ATV wrong-tab bug: a forwarded implement executed the mode flip
    // against the owner's activeTabId. With two tabs and tab-2 active, the
    // old pipeline flipped tab-2 and left tab-1 in plan mode (the send-slice
    // prompt_sync then re-asserted plan and the tab filed under Planning).
    const tab1 = makeTab({ id: 'tab-1' })
    const tab2 = makeTab({ id: 'tab-2' })
    const { state } = buildHarness([tab1, tab2], { permissionMode: 'plan', planFilePath: '/plans/test.md' }, 'tab-2')

    await state.implementPlan('tab-1', {})

    const resolved = state.tabs.find((t: TabState) => t.id === 'tab-1')!
    expect(effectivePermissionMode(resolved, state.conversationPanes)).toBe('auto')
    // And the engine flip went to tab-1, not the active tab-2.
    const flips = mockSetPermissionMode.mock.calls.filter((c) => c[1] === 'auto' && c[3] === undefined)
    expect(flips.some((c) => c[0] === 'tab-1')).toBe(true)
    expect(mockSetPermissionMode.mock.calls.every((c) => c[0] !== 'tab-2')).toBe(true)
  })

  it('submits the implement prompt with implementationPhase', async () => {
    const tab = makeTab()
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: '/plans/test.md' })

    await state.implementPlan('tab-1', {})

    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const args = mockPrompt.mock.calls[0] as unknown as any[]
    expect(args[2].implementationPhase).toBe(true)
  })
})

describe('implementPlan — Implement and Unpin ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPrefs()
    mockPrompt.mockResolvedValue(undefined)
    mockReadPlan.mockResolvedValue({ content: '# plan body' })
  })

  it('unpins INSIDE the action so the in-progress auto-move is not suppressed', async () => {
    // The "moved to Planning instead of In-Progress" bug: unpin and the pin
    // check ran in different windows, so the check read the stale pinned
    // state and suppressed the move. As one owner-executed action the unpin
    // commits synchronously before the check.
    prefs.autoGroupMovement = true
    const tab = makeTab({ groupId: 'group-ondeck', groupPinned: true })
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: '/plans/test.md' })

    await state.implementPlan('tab-1', { unpin: true })

    const resolved = state.tabs.find((t: TabState) => t.id === 'tab-1')!
    expect(resolved.groupPinned).toBe(false)
    expect(state.moveTabToGroup).toHaveBeenCalledWith('tab-1', 'group-inprogress')
  })

  it('without unpin, a pinned tab still suppresses the auto-move (user pinned it on purpose)', async () => {
    prefs.autoGroupMovement = true
    const tab = makeTab({ groupId: 'group-ondeck', groupPinned: true })
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: '/plans/test.md' })

    await state.implementPlan('tab-1', {})

    expect(state.tabs.find((t: TabState) => t.id === 'tab-1')!.groupPinned).toBe(true)
    expect(state.moveTabToGroup).not.toHaveBeenCalled()
  })

  it('dismisses the denial card on the tab instance', async () => {
    const denied = { tools: [{ toolName: 'ExitPlanMode', toolUseId: 'x', toolInput: { planFilePath: '/plans/test.md' } }] }
    const tab = makeTab()
    const { state } = buildHarness(tab, { permissionMode: 'plan', permissionDenied: denied })

    await state.implementPlan('tab-1', {})

    const pane = state.conversationPanes.get('tab-1')!
    const inst = pane.instances.find((i: any) => i.id === pane.activeInstanceId) ?? pane.instances[0]
    expect(inst.permissionDenied).toBeNull()
    // The denial's toolInput served as the planFilePath fallback for the read.
    expect(mockReadPlan).toHaveBeenCalledWith('/plans/test.md')
  })
})

describe('implementPlan — planFilePath cleared on instance after implement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPrefs()
    mockPrompt.mockResolvedValue(undefined)
    mockReadPlan.mockResolvedValue({ content: '# plan body' })
  })

  it('clears instance.planFilePath to null (not a silent no-op on tabs[])', async () => {
    const tab = makeTab()
    const PLAN_PATH = '/Users/josh/.ion/plans/bold-guiding-kite.md'
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: PLAN_PATH })

    const paneBefore = state.conversationPanes.get('tab-1')!
    const instBefore = paneBefore.instances.find((i: any) => i.id === paneBefore.activeInstanceId) ?? paneBefore.instances[0]
    expect(instBefore.planFilePath).toBe(PLAN_PATH)

    mockReadPlan.mockResolvedValue({ content: '# plan' })

    await state.implementPlan('tab-1', {})

    // After implement the instance.planFilePath must be null — the path was
    // consumed and must not linger to contaminate a subsequent planning cycle.
    const paneAfter = state.conversationPanes.get('tab-1')!
    const instAfter = paneAfter.instances.find((i: any) => i.id === paneAfter.activeInstanceId) ?? paneAfter.instances[0]
    expect(instAfter.planFilePath).toBeNull()
  })
})

describe('implementPlan — clearContext branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPrefs()
    mockPrompt.mockResolvedValue(undefined)
    mockReadPlan.mockResolvedValue({ content: '# plan body' })
  })

  it('clearContext=true resets the session, archives the conversationId, and tags the cut', async () => {
    const tab = makeTab({ conversationId: 'conv-old', historicalSessionIds: [] })
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: '/plans/test.md' })

    await state.implementPlan('tab-1', { clearContext: true })

    // The engine session was torn down via the reset IPC.
    expect(mockResetTabSession).toHaveBeenCalledTimes(1)
    expect(mockResetTabSession).toHaveBeenCalledWith('tab-1')

    const resolvedTab = state.tabs.find((t: TabState) => t.id === 'tab-1')!
    // conversationId is cut to null; the prior id is archived and recorded as parent.
    expect(resolvedTab.conversationId).toBeNull()
    expect(resolvedTab.historicalSessionIds).toContain('conv-old')
    expect(resolvedTab.pendingParentConversationId).toBe('conv-old')

    // The active instance carries the 'clear' cut reason so the session ledger
    // tags the next minted id.
    const pane = state.conversationPanes.get('tab-1')!
    const inst = pane.instances.find((i: any) => i.id === pane.activeInstanceId) ?? pane.instances[0]
    expect(inst.pendingCutReason).toBe('clear')

    // Still submits the implement prompt with implementationPhase.
    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const args = mockPrompt.mock.calls[0] as unknown as any[]
    expect(args[2].implementationPhase).toBe(true)
  })

  it('clearContext=false (default Implement) preserves the conversation — no reset', async () => {
    const tab = makeTab({ conversationId: 'conv-keep', historicalSessionIds: [] })
    const { state } = buildHarness(tab, { permissionMode: 'plan', planFilePath: '/plans/test.md' })

    await state.implementPlan('tab-1', {})

    // No session teardown; conversation is preserved across the plan→implement boundary.
    expect(mockResetTabSession).not.toHaveBeenCalled()
    const resolvedTab = state.tabs.find((t: TabState) => t.id === 'tab-1')!
    expect(resolvedTab.conversationId).toBe('conv-keep')
    expect(resolvedTab.historicalSessionIds).not.toContain('conv-keep')

    const pane = state.conversationPanes.get('tab-1')!
    const inst = pane.instances.find((i: any) => i.id === pane.activeInstanceId) ?? pane.instances[0]
    expect(inst.pendingCutReason).toBeUndefined()
  })
})
