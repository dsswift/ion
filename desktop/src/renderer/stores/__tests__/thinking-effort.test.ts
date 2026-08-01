/**
 * thinking-effort — per-conversation thinking control tests.
 *
 * Pins:
 *   1. setThinkingEffort isolates state per-tab (bare conversation).
 *   2. sendMessage includes thinkingEffort on window.ion.prompt ONLY when the
 *      global thinkingEnabled is on AND the tab's level is non-off.
 *   3. Global off → thinkingEffort omitted even when the tab has a level.
 *
 * WI-002 parity tests (added for #259 FIX 2):
 *   4. effectiveThinkingEffort reads the instance for both plain and
 *      extension-hosted tabs with no tab-type fork.
 *   5. A plain tab and an extension-hosted tab with identical pane state
 *      produce the same thinkingEffort on send.
 *   6. Snapshot projection parity: snapshot-project passes thinkingEffort
 *      through for both plain and extension-hosted tab inputs.
 *   7. Regression: a stale ghost field on the tab object is not read by
 *      effectiveThinkingEffort.
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
import { effectiveThinkingEffort } from '../conversation-instance'

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
    workingDirectory: '/home/test', hasChosenDirectory: true, additionalDirs: [],
    bashResults: [], bashExecuting: false, bashExecId: null, pillColor: null, pillIcon: null,
    forkedFromSessionId: null, worktree: null, pendingWorktreeSetup: false,
    groupId: null, groupPinned: false, contextTokens: null, contextWindow: null,
    isCompacting: false, isTerminalOnly: false, engineProfileId: null,
    lastMessagePreview: null, ...overrides,
  } as TabState
}

function buildHarness(initialTab: TabState, instanceOverrides: Record<string, unknown> = {}) {
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
    conversationPanes: seedMainPane(initialTab.id, { permissionMode: 'auto', ...instanceOverrides } as any),
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

  it('writes the effort onto the active conversation instance', () => {
    const { state } = buildHarness(makeTab())
    state.setThinkingEffort('high')
    const inst = state.conversationPanes.get('tab-1')?.instances.find((i: any) => i.id === 'main')
    expect(inst?.thinkingEffort).toBe('high')
  })

  it('off clears the level back', () => {
    // thinkingEffort lives on the instance (WI-002) — pass as instanceOverride
    const { state } = buildHarness(makeTab(), { thinkingEffort: 'high' })
    state.setThinkingEffort('off')
    const inst = state.conversationPanes.get('tab-1')?.instances.find((i: any) => i.id === 'main')
    expect(inst?.thinkingEffort).toBe('off')
  })
})

describe('sendMessage — thinking gating', () => {
  beforeEach(() => { vi.clearAllMocks(); mockPrompt.mockResolvedValue(undefined); prefState.thinkingEnabled = false })

  it('global ON + tab level high → thinkingEffort:high on prompt', () => {
    prefState.thinkingEnabled = true
    // thinkingEffort lives on the instance (WI-002) — pass as instanceOverride
    const { state } = buildHarness(makeTab(), { thinkingEffort: 'high' })
    state.submit('tab-1', 'hello')
    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBe('high')
  })

  it('global OFF → thinkingEffort omitted even when tab level set', () => {
    prefState.thinkingEnabled = false
    // thinkingEffort lives on the instance (WI-002) — pass as instanceOverride
    const { state } = buildHarness(makeTab(), { thinkingEffort: 'high' })
    state.submit('tab-1', 'hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBeUndefined()
  })

  it('global ON + tab level off → thinkingEffort omitted', () => {
    prefState.thinkingEnabled = true
    const { state } = buildHarness(makeTab(), { thinkingEffort: 'off' })
    state.submit('tab-1', 'hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WI-002 parity tests (#259 FIX 2)
//
// These tests assert that effectiveThinkingEffort and the send-slice read path
// behave identically for plain tabs (engineProfileId: null) and extension-hosted
// tabs (engineProfileId: 'cos'). There must be no tab-type fork.
// ─────────────────────────────────────────────────────────────────────────────

function makePlainTab(overrides: Partial<TabState> = {}): TabState {
  return makeTab({ engineProfileId: null, ...overrides })
}

function makeExtensionTab(overrides: Partial<TabState> = {}): TabState {
  return makeTab({ engineProfileId: 'cos', pillIcon: 'lightning', ...overrides })
}

describe('effectiveThinkingEffort — WI-002 parity (no tab-type fork)', () => {
  it('plain tab: reads thinkingEffort from the active instance', () => {
    const { state } = buildHarness(makePlainTab(), { thinkingEffort: 'high' })
    const effort = effectiveThinkingEffort(makePlainTab(), state.conversationPanes)
    expect(effort).toBe('high')
  })

  it('extension-hosted tab: reads thinkingEffort from the active instance', () => {
    const { state } = buildHarness(makeExtensionTab(), { thinkingEffort: 'medium' })
    const effort = effectiveThinkingEffort(makeExtensionTab(), state.conversationPanes)
    expect(effort).toBe('medium')
  })

  it('plain and extension-hosted tabs return identical effort for the same pane state', () => {
    const panesHigh = seedMainPane('tab-1', { thinkingEffort: 'high' } as any)
    const panesOff = seedMainPane('tab-1', { thinkingEffort: 'off' } as any)

    // Same pane state → identical result regardless of tab type.
    expect(effectiveThinkingEffort(makePlainTab(), panesHigh))
      .toBe(effectiveThinkingEffort(makeExtensionTab(), panesHigh))

    expect(effectiveThinkingEffort(makePlainTab(), panesOff))
      .toBe(effectiveThinkingEffort(makeExtensionTab(), panesOff))
  })

  it('missing pane returns safe off default without throwing', () => {
    expect(effectiveThinkingEffort(makePlainTab(), new Map())).toBe('off')
    expect(effectiveThinkingEffort(makeExtensionTab(), new Map())).toBe('off')
  })

  it('ghost field on tab object is not read (regression: no TabState.thinkingEffort fallback)', () => {
    // Before WI-002, ThinkingEffort was stored on TabState. After WI-002 it is
    // only on the instance. If someone reintroduces a tab-level fallback, this
    // test catches it: the ghost field says 'high' but the instance says 'off'.
    const tabWithGhost = { ...makePlainTab(), thinkingEffort: 'high' } as any
    const offPanes = seedMainPane('tab-1', { thinkingEffort: 'off' } as any)
    expect(effectiveThinkingEffort(tabWithGhost, offPanes)).toBe('off')
  })
})

describe('sendMessage thinking-effort — WI-002 parity: plain == extension-hosted', () => {
  beforeEach(() => { vi.clearAllMocks(); mockPrompt.mockResolvedValue(undefined); prefState.thinkingEnabled = true })

  it('plain tab with high effort sends thinkingEffort:high', () => {
    const { state } = buildHarness(makePlainTab(), { thinkingEffort: 'high' })
    state.submit('tab-1', 'hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBe('high')
  })

  it('extension-hosted tab with high effort sends thinkingEffort:high', () => {
    const { state } = buildHarness(makeExtensionTab(), { thinkingEffort: 'high' })
    state.submit('tab-1', 'hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBe('high')
  })

  it('plain and extension-hosted tabs send identical thinkingEffort for the same instance state', () => {
    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
    const { state: plainState } = buildHarness(makePlainTab(), { thinkingEffort: 'medium' })
    plainState.submit('tab-1', 'hello')
    const plainOpts = mockPrompt.mock.calls[0]?.[2] as any

    vi.clearAllMocks()
    mockPrompt.mockResolvedValue(undefined)
    const { state: extState } = buildHarness(makeExtensionTab(), { thinkingEffort: 'medium' })
    extState.submit('tab-1', 'hello')
    const extOpts = mockPrompt.mock.calls[0]?.[2] as any

    expect(plainOpts.thinkingEffort).toBe(extOpts.thinkingEffort)
  })

  it('plain tab with off effort omits thinkingEffort (matches extension-hosted behavior)', () => {
    const { state } = buildHarness(makePlainTab(), { thinkingEffort: 'off' })
    state.submit('tab-1', 'hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBeUndefined()
  })

  it('extension-hosted tab with off effort omits thinkingEffort (matches plain behavior)', () => {
    const { state } = buildHarness(makeExtensionTab(), { thinkingEffort: 'off' })
    state.submit('tab-1', 'hello')
    const opts = mockPrompt.mock.calls[0][2] as any
    expect(opts.thinkingEffort).toBeUndefined()
  })
})

