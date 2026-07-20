/**
 * tab-slice — closeTab action-layer guard
 *
 * Pins the "no force-close" contract: a conversation tab whose orchestrator
 * is running OR whose dispatched background agents are still
 * executing CANNOT be closed via the action layer. The user must
 * stop the tab first (Interrupt + wait for children) before close is
 * allowed.
 *
 * The guard is TAB-TYPE-AGNOSTIC: the Agent tool dispatches background
 * sub-agents regardless of whether a harness is loaded, so a plain
 * conversation can have running children too. Both plain and extension-hosted
 * tabs are blocked from close while their orchestrator or children run.
 *
 * Mirrors the UI-layer suppression in TabStripTabPill.tsx (X button
 * hidden, middle-click no-op when closeBlocked). Together they
 * enforce the same rule at every entry point — keyboard shortcuts,
 * group-pill close, programmatic calls, future entry points.
 *
 * See plan: ~/.ion/plans/blue-studying-hill.md (deliverable 5,
 * "Hard-block tab close while running or awaiting children").
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../components/TerminalPanel', () => ({
  destroyTerminalInstance: vi.fn(),
}))

vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(),
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
}))

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'msg-x'),
  playNotificationIfHidden: vi.fn(async () => {}),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
  isReusableBlankConversationTab: vi.fn(() => false),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: vi.fn(() => ({
      tabGroups: [],
      tabGroupMode: 'off',
      stashedManualTabAssignments: {},
      setStashedManualTabAssignments: vi.fn(),
      defaultTallConversation: false,
      expandOnTabSwitch: false,
    })),
  },
  // closeTab → pickNextActiveTab needs the effective groups; identity is fine
  // for the 'off'-mode default and the manual-group override the test sets.
  getEffectiveTabGroups: (g: any) => g,
}))

import { createTabSlice } from '../slices/tab-slice'
import { rWarn } from '../../rendererLogger'
import { usePreferencesStore } from '../../preferences'
import type { State } from '../session-store-types'

const closeTabRpc = vi.fn().mockResolvedValue(undefined)

;(globalThis as any).window = {
  ion: {
    closeTab: closeTabRpc,
    gitWorktreeRemove: vi.fn().mockResolvedValue(undefined),
    terminalDestroy: vi.fn().mockResolvedValue(undefined),
    notifyTabFocus: vi.fn(),
  },
}

function makeEngineTab(id: string) {
  return {
    id,
    title: 'Engine Tab',
    customTitle: null,
    engineProfileId: 'test-profile',
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    elicitationQueue: [],
    permissionDenied: null,
    attachments: [],
    draftInput: '',
    messages: [],
    queuedPrompts: [],
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    hasFileActivity: false,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    bashExecuting: false,
    bashExecId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    additionalDirs: [],
    permissionMode: 'auto' as const,
    planFilePath: null,
    bashResults: [],
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    sessionModel: null,
    modelOverride: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    conversationId: null,
    lastResult: null,
    lastMessagePreview: null,
  }
}

function makeCliTab(id: string) {
  return { ...makeEngineTab(id), engineProfileId: null }
}

interface Harness {
  state: any
  slice: Partial<State>
  warnSpy: ReturnType<typeof vi.fn>
}

function buildHarness(tabs: any[], opts?: { activeTabId?: string }): Harness {
  const state: any = {
    tabs,
    activeTabId: opts?.activeTabId ?? null,
    conversationPanes: new Map(),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    fileExplorerOpenDirs: new Set(),
    fileEditorOpenDirs: new Set(),
    stashedManualTabAssignments: new Map(),
    // Skeleton-hydration entry point selectTab calls; stub so the regression
    // test can assert it fires for an un-hydrated existing conversation.
    loadSkeletonMessages: vi.fn().mockResolvedValue(undefined),
  }
  const set = (patch: any) => {
    if (typeof patch === 'function') Object.assign(state, patch(state))
    else Object.assign(state, patch)
  }
  const get = () => state
  const slice = createTabSlice(set, get) as Partial<State>
  // Expose the slice's own selectTab on the state so closeTab's
  // get().selectTab(...) resolves to the real activation path under test.
  state.selectTab = slice.selectTab
  // The action-layer guard logs its refusal via rWarn (ADR-019 structured
  // logging) — the mocked logger captures it so tests can assert the refusal
  // reason.
  return { state, slice, warnSpy: vi.mocked(rWarn) }
}

beforeEach(() => {
  closeTabRpc.mockClear()
  vi.mocked(rWarn).mockClear()
})

describe('closeTab action-layer guard', () => {
  it('allows close when the engine tab is truly idle', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'inst1', label: 'inst1', statusFields: { state: 'idle' }, agentStates: [] }], activeInstanceId: 'inst1' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).toHaveBeenCalledWith('tab1')
    expect(h.warnSpy).not.toHaveBeenCalled()
    h.warnSpy.mockClear()
  })

  it('refuses close when the orchestrator is running', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'inst1', label: 'inst1', statusFields: { state: 'running' }, agentStates: [] }], activeInstanceId: 'inst1' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(h.warnSpy).toHaveBeenCalledWith('tab.close', 'close blocked by guard', expect.objectContaining({ reason: expect.stringContaining('refused tab close') }))
    expect(h.warnSpy).toHaveBeenCalledWith('tab.close', 'close blocked by guard', expect.objectContaining({ reason: expect.stringContaining('orchestratorRunning=true') }))
    h.warnSpy.mockClear()
  })

  it('refuses close when the orchestrator is connecting', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'inst1', label: 'inst1', statusFields: { state: 'connecting' }, agentStates: [] }], activeInstanceId: 'inst1' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(h.warnSpy).toHaveBeenCalled()
    h.warnSpy.mockClear()
  })

  it('refuses close when the orchestrator is idle but background children are running', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', {
      instances: [{
        id: 'inst1', label: 'inst1',
        statusFields: { state: 'idle' },
        agentStates: [{ name: 'agent-a', status: 'running' }, { name: 'agent-b', status: 'done' }],
      }],
      activeInstanceId: 'inst1',
    })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(h.warnSpy).toHaveBeenCalledWith('tab.close', 'close blocked by guard', expect.objectContaining({ reason: expect.stringContaining('refused tab close') }))
    expect(h.warnSpy).toHaveBeenCalledWith('tab.close', 'close blocked by guard', expect.objectContaining({ reason: expect.stringContaining('inst1:1') }))
    h.warnSpy.mockClear()
  })

  it('refuses close when a sibling instance has running children', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', {
      instances: [
        { id: 'inst1', label: 'inst1', statusFields: { state: 'idle' }, agentStates: [] },
        { id: 'inst2', label: 'inst2', statusFields: { state: 'idle' }, agentStates: [{ name: 'agent-a', status: 'running' }] },
      ],
      activeInstanceId: 'inst1',
    })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(h.warnSpy).toHaveBeenCalled()
    h.warnSpy.mockClear()
  })

  // ─── Tab-type parity (DB-1): the guard is TAB-TYPE-AGNOSTIC ───────────────
  // A plain/CLI conversation can dispatch background sub-agents (the Agent tool
  // works without a harness), so a plain tab with a running orchestrator or
  // running children must be blocked from close exactly like an extension tab.
  // Pre-fix the guard was gated on tabHasExtensions and let these close,
  // silently killing the sub-agents.

  it('refuses close on a PLAIN tab when the orchestrator is running (DB-1)', () => {
    const tab = makeCliTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'main', label: 'main', statusFields: { state: 'running' }, agentStates: [] }], activeInstanceId: 'main' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(h.warnSpy).toHaveBeenCalledWith('tab.close', 'close blocked by guard', expect.objectContaining({ reason: expect.stringContaining('orchestratorRunning=true') }))
    h.warnSpy.mockClear()
  })

  it('refuses close on a PLAIN tab when background children are running (DB-1)', () => {
    const tab = makeCliTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', {
      instances: [{
        id: 'main', label: 'main',
        statusFields: { state: 'idle' },
        agentStates: [{ name: 'sub-agent', status: 'running' }],
      }],
      activeInstanceId: 'main',
    })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).not.toHaveBeenCalled()
    expect(h.warnSpy).toHaveBeenCalledWith('tab.close', 'close blocked by guard', expect.objectContaining({ reason: expect.stringContaining('main:1') }))
    h.warnSpy.mockClear()
  })

  it('allows close on a PLAIN tab that is quiescent (no running orchestrator/children)', () => {
    const tab = makeCliTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'main', label: 'main', statusFields: { state: 'idle' }, agentStates: [] }], activeInstanceId: 'main' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).toHaveBeenCalledWith('tab1')
    expect(h.warnSpy).not.toHaveBeenCalled()
    h.warnSpy.mockClear()
  })

  // ─── conversationPane cleanup (DB-2): pane deleted on close for ALL tabs ───
  // Every tab is seeded a conversationPane at creation; gating the cleanup on
  // tabHasExtensions leaked the pane for plain tabs on close.

  it('deletes the conversationPane on close for a PLAIN tab (DB-2 — no leak)', () => {
    const tab = makeCliTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'main', label: 'main', statusFields: { state: 'idle' }, agentStates: [] }], activeInstanceId: 'main' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).toHaveBeenCalledWith('tab1')
    expect(h.state.conversationPanes.get('tab1')).toBeUndefined()
    h.warnSpy.mockClear()
  })

  it('deletes the conversationPane on close for an extension tab (DB-2 parity)', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'main', label: 'main', statusFields: { state: 'idle' }, agentStates: [] }], activeInstanceId: 'main' })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).toHaveBeenCalledWith('tab1')
    expect(h.state.conversationPanes.get('tab1')).toBeUndefined()
    h.warnSpy.mockClear()
  })

  it('allows close once all children flip to terminal status', () => {
    const tab = makeEngineTab('tab1')
    const h = buildHarness([tab])
    h.state.conversationPanes.set('tab1', {
      instances: [{
        id: 'inst1', label: 'inst1',
        statusFields: { state: 'idle' },
        agentStates: [
          { name: 'agent-a', status: 'done' },
          { name: 'agent-b', status: 'cancelled' },
          { name: 'agent-c', status: 'error' },
        ],
      }],
      activeInstanceId: 'inst1',
    })

    h.slice.closeTab!('tab1')

    expect(closeTabRpc).toHaveBeenCalledWith('tab1')
    expect(h.warnSpy).not.toHaveBeenCalled()
    h.warnSpy.mockClear()
  })
})

// ─── Next-active activation routes through selectTab (limbo-state fix) ────────
// Closing the active tab in a multi-tab group must activate the next tab via the
// selectTab action — NOT a raw `set({ activeTabId })`. Only selectTab triggers
// skeleton hydration (loadSkeletonMessages) for an existing conversation never
// visited this session. The pre-fix raw write skipped hydration and left the
// activated tab in a limbo state: empty scrollback while its persisted plan card
// still rendered. This test fails on the raw-write code and passes after the fix.
describe('closeTab next-active activation', () => {
  beforeEach(() => {
    closeTabRpc.mockClear()
  })

  it('activates the in-group sibling via selectTab and hydrates its skeleton', () => {
    // Two existing conversations in the same manual group. tab1 is active and
    // closing; tab2 is an un-hydrated skeleton (messageCount > 0, empty messages).
    const tab1 = { ...makeCliTab('tab1'), groupId: 'planning', conversationId: 'conv-1', workingDirectory: '/repo' }
    const tab2 = { ...makeCliTab('tab2'), groupId: 'planning', conversationId: 'conv-2', workingDirectory: '/repo' }
    const h = buildHarness([tab1, tab2], { activeTabId: 'tab1' })
    // Manual mode so group membership is groupId-driven.
    ;(usePreferencesStore.getState as any).mockReturnValueOnce({
      tabGroups: [{ id: 'planning', label: 'Planning', isDefault: true, order: 0, collapsed: false }],
      tabGroupMode: 'manual',
      stashedManualTabAssignments: {},
      setStashedManualTabAssignments: vi.fn(),
      defaultTallConversation: false,
      expandOnTabSwitch: false,
    })
    // Closing tab1: idle, no children → close allowed.
    h.state.conversationPanes.set('tab1', { instances: [{ id: 'main', label: 'main', statusFields: { state: 'idle' }, agentStates: [] }], activeInstanceId: 'main' })
    // tab2 is a skeleton: persisted messageCount but empty messages → selectTab
    // must call loadSkeletonMessages('tab2').
    h.state.conversationPanes.set('tab2', { instances: [{ id: 'main', label: 'main', messages: [], messageCount: 5, statusFields: { state: 'idle' }, agentStates: [] }], activeInstanceId: 'main' })

    const selectSpy = vi.spyOn(h.state, 'selectTab')

    h.slice.closeTab!('tab1')

    // Activation went through selectTab with the in-group sibling, not a raw write.
    expect(selectSpy).toHaveBeenCalledWith('tab2')
    expect(h.state.activeTabId).toBe('tab2')
    // selectTab reached the skeleton-hydration trigger for the existing conversation.
    expect(h.state.loadSkeletonMessages).toHaveBeenCalledWith('tab2')

    selectSpy.mockRestore()
    h.warnSpy.mockClear()
  })
})
