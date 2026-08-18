/**
 * Status resync — the answer to an unanswered optimistic 'connecting'.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Tab status lives in two places: the main-process control plane (authoritative)
 * and this store (optimistic). The renderer writes 'connecting' locally before a
 * session exists — `send-slice` on submit, `addEngineInstance`, and
 * `createConversationTab` — and clears it only when an inbound
 * `tab-status-change` arrives.
 *
 * The plane's `_setStatus` returns early when the status is unchanged, so a tab
 * whose plane entry has rested at 'idle' since `createTab` emits NOTHING when its
 * session comes online. The renderer's 'connecting' is then never answered: the
 * tab shows the connecting indicator with a blocked composer (`InputBar`
 * `isConnecting` → "Initializing…") while the status bar reads it as foreground
 * work, and the plane believes the tab is idle and available. Observed live: a
 * new worktree conversation stuck for 7 minutes, and an eager-restored tab stuck
 * for 15 until an Implement click finally forced a real transition.
 *
 * ── The two halves of the fix, pinned here ──────────────────────────────────
 * 1. The plane re-asserts its status at session establishment, emitting
 *    old === new (`_resyncStatus`). This store must treat that as a resync — a
 *    status convergence with NO run-lifecycle meaning — not as a run ending.
 *    Running the terminal-transition side effects on it would clear a restored
 *    plan-ready card and a live permission queue on a tab that did not finish a
 *    run.
 * 2. `addEngineInstance` clears its own 'connecting' when engineStart resolves
 *    ok, so the root-cause path does not depend on the backstop above.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))
vi.mock('../slices/event-slice-done-move', () => ({
  maybeScheduleDoneMove: vi.fn(),
  maybeApplyAgentStateGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-running-move', () => ({ maybeScheduleRunningMove: vi.fn() }))

import { createEventSlice } from '../slices/event-slice'
import { maybeScheduleDoneMove } from '../slices/event-slice-done-move'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'
import type { TabStatus } from '../../../shared/types'

function buildHarness(status: TabStatus, permissionDenied: any = null) {
  const inst = {
    id: 'main', label: 'main', messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied, permissionQueue: [] as any[], elicitationQueue: [] as any[],
    conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null,
    thinkingEffort: 'off', sealed: false, dispatchTelemetry: [], contextBreakdown: null,
  }
  const state: any = {
    tabs: [{
      id: 'tab1', status, lastEventAt: 0, permissionDenied: null, contextTokens: 0, contextPercent: 0,
      hasUnread: false, queuedPrompts: [], historicalSessionIds: [], permissionMode: 'auto',
      activeRequestId: 'req-1', currentActivity: 'thinking',
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [inst], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const slice = createEventSlice(set, () => state as State) as State
  return { state, slice }
}

const tab = (state: any) => state.tabs.find((t: any) => t.id === 'tab1')

describe('handleStatusChange — resync (old === new)', () => {
  it('converges a stranded connecting tab to the plane status (REGRESSION)', () => {
    // The wedge: renderer wrote 'connecting' optimistically, the plane rested at
    // 'idle' and emitted no transition. This resync is the only thing that frees
    // the composer, so convergence is the property the whole fix exists for —
    // pinned here even though the pre-fix handler also converged (it just never
    // received the event, which is what the plane-side test covers). The two
    // tests below are the ones that are RED on unfixed code.
    const { state, slice } = buildHarness('connecting')

    slice.handleStatusChange('tab1', 'idle', 'idle')

    expect(tab(state).status).toBe('idle')
  })

  it('carries no run-lifecycle meaning — keeps a pending card and the queue', () => {
    const denial = { toolName: 'ExitPlanMode', toolUseID: 'tu-1' }
    const { state, slice } = buildHarness('connecting', denial)
    activeInstance(state.conversationPanes, 'tab1')!.permissionQueue.push({ id: 'p-1' } as any)

    slice.handleStatusChange('tab1', 'idle', 'idle')

    const inst = activeInstance(state.conversationPanes, 'tab1')!
    expect(inst.permissionDenied).toEqual(denial)
    expect(inst.permissionQueue).toHaveLength(1)
    expect(maybeScheduleDoneMove).not.toHaveBeenCalled()
  })

  it('is a no-op when the renderer already agrees', () => {
    const { state, slice } = buildHarness('idle')
    const before = state.tabs

    slice.handleStatusChange('tab1', 'idle', 'idle')

    // Same array reference: no spurious re-render for a status that never moved.
    expect(state.tabs).toBe(before)
  })

  it('leaves a real transition fully intact', () => {
    // The guard must not swallow the normal path: running → idle is a run
    // ending and still clears run-scoped state.
    const denial = { toolName: 'ExitPlanMode', toolUseID: 'tu-2' }
    const { state, slice } = buildHarness('running', denial)

    slice.handleStatusChange('tab1', 'idle', 'running')

    expect(tab(state).status).toBe('idle')
    expect(tab(state).activeRequestId).toBeNull()
    expect(activeInstance(state.conversationPanes, 'tab1')!.permissionDenied).toBeNull()
    expect(maybeScheduleDoneMove).toHaveBeenCalled()
  })
})
