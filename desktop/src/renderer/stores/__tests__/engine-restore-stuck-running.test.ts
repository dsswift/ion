/**
 * REGRESSION: restored extension tabs must not get stuck in `running`.
 *
 * Symptom: "all tabs with extensions show as running after I reinstalled and
 * restarted." Root cause: a restored extension tab re-starts its engine session
 * on load (useTabRestoration-engine.ts → window.ion.engineStart), which bypasses
 * the control plane (ipc/engine.ts ENGINE_START → engineBridge.startSession with
 * no sessionPlane.ensureTab). The harness's session_start hook commonly fires an
 * initial turn, producing a `session_init` with no user prompt. Before the fix,
 * event-slice.ts flipped status to 'running' off that warmup session_init
 * (gated only on `isWarmup`, a desktop-only flag the engine never sets), and the
 * control plane's engine_status→task_complete idle mediation never runs for the
 * bypassed tab — so nothing cleared it and the tab stuck on 'running'.
 *
 * The fix gates the running transition on an in-flight user request: the send
 * path sets status='connecting' + activeRequestId BEFORE dispatching, so a
 * genuine user-initiated session_init always arrives on a connecting/running tab
 * with an activeRequestId. A session_init on an idle tab with no active request
 * is a restore/reconnect warmup and must not flip to running.
 *
 * These tests would go RED with the gate reverted (a plain `if (!event.isWarmup)`
 * flips the idle restored tab to 'running').
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn((() => {
    let n = 0
    return () => `msg-${++n}`
  })()),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
  cancelDoneGroupMove: vi.fn(() => false),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      expandToolResults: false,
      aiGeneratedTitles: false,
      autoGroupMovement: false,
      tabGroupMode: 'manual',
      doneGroupId: null,
      inProgressGroupId: null,
    }),
  },
}))

vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [],
    elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [],
    statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
    lastMessagePreview: null,
    dispatchTelemetry: [], contextBreakdown: null,
  }
}

/**
 * Build a store whose single tab starts in a given status / activeRequestId,
 * mirroring the two real entry conditions:
 *   - restore/reconnect: status='idle', activeRequestId=null (no user send)
 *   - user send:         status='connecting', activeRequestId set (send-slice
 *                        ran before dispatch)
 */
function buildStore(opts: {
  isExtensionTab: boolean
  status: string
  activeRequestId: string | null
}) {
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [{
      id: 'tab1',
      engineProfileId: opts.isExtensionTab ? 'ext-profile' : null,
      status: opts.status,
      lastEventAt: 0,
      contextTokens: 0,
      contextPercent: 0,
      currentActivity: '',
      conversationId: null,
      lastResult: null,
      sessionTools: [],
      sessionMcpServers: [],
      sessionSkills: [],
      sessionVersion: '',
      activeRequestId: opts.activeRequestId,
      queuedPrompts: [],
      historicalSessionIds: [],
      isCompacting: false,
      hasUnread: false,
      groupId: null,
      groupPinned: false,
      customTitle: null,
      pillColor: null,
      pillIcon: null,
      title: opts.isExtensionTab ? 'Ext Tab' : 'Plain Tab',
      workingDirectory: '/tmp',
      hasChosenDirectory: true,
    }],
    conversationPanes: new Map([['tab1', { instances: [makeInstance('main')], activeInstanceId: 'main' }]]),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    backend: 'api',
    resources: new Map(),
    resourceSubscriptions: new Map(),
    readResourceIds: new Set(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

const SESSION_INIT = {
  type: 'session_init' as const,
  sessionId: 'sess-1',
  model: 'claude-sonnet-4-6',
  tools: [],
  mcpServers: [],
  skills: [],
  version: '1.0',
  // isWarmup is the desktop-only flag the engine never sets; a raw
  // extension-tab session_init on restore always has it undefined.
}

describe('restore: session_init must not strand an extension tab in running', () => {
  it('warmup session_init on an idle restored extension tab does NOT flip to running', () => {
    const { state, slice } = buildStore({ isExtensionTab: true, status: 'idle', activeRequestId: null })
    slice.handleNormalizedEvent('tab1', SESSION_INIT as any)
    expect(state.tabs[0].status).toBe('idle')
  })

  it('warmup session_init on an idle restored plain tab does NOT flip to running', () => {
    const { state, slice } = buildStore({ isExtensionTab: false, status: 'idle', activeRequestId: null })
    slice.handleNormalizedEvent('tab1', SESSION_INIT as any)
    expect(state.tabs[0].status).toBe('idle')
  })

  it('still captures conversationId from the warmup session_init (capture is ungated)', () => {
    const { state, slice } = buildStore({ isExtensionTab: true, status: 'idle', activeRequestId: null })
    slice.handleNormalizedEvent('tab1', SESSION_INIT as any)
    // The status flip is gated, but conversationId capture must still run so the
    // restored session records its sessionId (persistence + crash recovery).
    expect(state.tabs[0].conversationId).toBe('sess-1')
    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.conversationIds).toContain('sess-1')
  })
})

describe('send: user-initiated session_init still flips to running', () => {
  it('session_init on a connecting extension tab with an active request flips to running', () => {
    const { state, slice } = buildStore({ isExtensionTab: true, status: 'connecting', activeRequestId: 'req-1' })
    slice.handleNormalizedEvent('tab1', SESSION_INIT as any)
    expect(state.tabs[0].status).toBe('running')
    expect(state.tabs[0].currentActivity).toBe('Thinking...')
  })

  it('session_init on a connecting plain tab with an active request flips to running', () => {
    const { state, slice } = buildStore({ isExtensionTab: false, status: 'connecting', activeRequestId: 'req-1' })
    slice.handleNormalizedEvent('tab1', SESSION_INIT as any)
    expect(state.tabs[0].status).toBe('running')
  })

  it('session_init while already running (queued-prompt drain) stays running', () => {
    const { state, slice } = buildStore({ isExtensionTab: true, status: 'running', activeRequestId: 'req-1' })
    slice.handleNormalizedEvent('tab1', SESSION_INIT as any)
    expect(state.tabs[0].status).toBe('running')
  })
})

// ─── Restore-time status (restoredConversationStatus) ───────────────────────
//
// The renderer-side root cause of the stuck-running/connecting symptom:
// createConversationTab sets a NEW extension tab to 'connecting' for its
// connecting indicator. On RESTORE there is no transition out of 'connecting'
// (the engine goes straight to idle and the control plane suppresses that idle),
// so the tab is stranded showing the orange indicator + interrupt button and
// cannot accept input. restoreSingleInstanceTab must override that with the
// restored resting status — never 'connecting'.
//
// restoredConversationStatus is the pure decision the restore path uses; pinning it
// here pins the contract at its stable seam. These would go RED if the restore
// path ever returned 'connecting' or mislabeled a pending-card tab.

import { restoredConversationStatus } from '../../hooks/useTabRestoration-status'

describe('restoredConversationStatus: restored tab never rests at connecting', () => {
  it('returns idle for a plain restored instance (no pending card)', () => {
    expect(restoredConversationStatus({ permissionDenied: null, permissionQueue: [] })).toBe('idle')
  })

  it('returns idle for a missing instance', () => {
    expect(restoredConversationStatus(null)).toBe('idle')
    expect(restoredConversationStatus(undefined)).toBe('idle')
  })

  it('returns completed when a restored permission denial (AskUserQuestion) is present', () => {
    expect(
      restoredConversationStatus({
        permissionDenied: { tools: [{ toolName: 'AskUserQuestion', toolUseId: 'x', toolInput: {} }] },
        permissionQueue: [],
      }),
    ).toBe('completed')
  })

  it('returns completed when a restored permission queue is non-empty', () => {
    expect(
      restoredConversationStatus({ permissionDenied: null, permissionQueue: [{ questionId: 'q1' }] }),
    ).toBe('completed')
  })

  it('never returns connecting (the stuck-tab value) for any input shape', () => {
    const inputs = [
      null,
      undefined,
      { permissionDenied: null, permissionQueue: [] },
      { permissionDenied: { tools: [] }, permissionQueue: [] },
      { permissionDenied: { tools: [{ toolName: 'ExitPlanMode' }] }, permissionQueue: [] },
      { permissionDenied: null, permissionQueue: [{ questionId: 'q' }] },
    ]
    for (const inp of inputs) {
      expect(restoredConversationStatus(inp as any)).not.toBe('connecting')
    }
  })
})
