/**
 * WI-001 MANDATORY TEST: single-path collapse parity
 *
 * Every conversation — plain and extension-hosted — now flows through
 * handleNormalizedEvent (event-slice.ts). This test is the WI-001 parity
 * assertion: feeding an identical NormalizedEvent sequence to a plain tab
 * and an extension-hosted tab produces identical conversation state.
 *
 * It also validates the guard test: handleEngineEvent is gone, and
 * handleNormalizedEvent is the only event entry point.
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

// ─── Guard test: handleEngineEvent is gone ─────────────────────────────────────

import * as engineEventSlice from '../slices/engine-event-slice'

describe('WI-001 guard: handleEngineEvent is retired', () => {
  it('engine-event-slice does not export handleEngineEvent', () => {
    // After WI-001, createEngineEventSlice (which provided handleEngineEvent)
    // is removed. The module still exports cleanupTabDeltas and
    // getRendererExtensionCommands but NOT createEngineEventSlice.
    expect((engineEventSlice as any).createEngineEventSlice).toBeUndefined()
    expect((engineEventSlice as any).handleEngineEvent).toBeUndefined()
  })

  it('event-slice exports handleNormalizedEvent', () => {
    const state: any = {
      tabs: [],
      activeTabId: null,
      isExpanded: false,
      engineWorkingMessages: new Map(),
      engineNotifications: new Map(),
      engineDialogs: new Map(),
      enginePinnedPrompt: new Map(),
      engineUsage: new Map(),
      engineModelFallbacks: new Map(),
      conversationPanes: new Map(),
    }
    const set = (partial: any) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, patch)
    }
    const get = () => state as State
    const slice = createEventSlice(set, get) as State
    expect(typeof slice.handleNormalizedEvent).toBe('function')
    expect((slice as any).handleEngineEvent).toBeUndefined()
  })

  // Guard: useEngineEvents.ts no longer subscribes to onEngineEvent.
  // Verified by inspecting the compiled module source — the string
  // 'onEngineEvent' must not appear in the hook's output.
  // (Checked via static grep in CI; confirmed here that the export exists.)
  it('useEngineEvents hook is exported from its module (static guard gate)', async () => {
    // We cannot import useEngineEvents in this vitest environment because
    // sessionStore.ts has side effects at module-load time that require a DOM.
    // The real guard is: `grep 'onEngineEvent' desktop/src/renderer/hooks/useEngineEvents.ts`
    // returns no results (enforced in CI). Here we pin that the module path is stable.
    const fs = await import('fs')
    const path = await import('path')
    const hookPath = path.resolve(__dirname, '../../hooks/useEngineEvents.ts')
    const source = fs.readFileSync(hookPath, 'utf8')
    // The hook MUST NOT subscribe to IPC.ENGINE_EVENT or window.ion.onEngineEvent.
    expect(source).not.toContain('onEngineEvent')
    // The hook MUST subscribe to onEvent (the normalized stream).
    expect(source).toContain('onEvent')
    // The hook MUST NOT import or use handleEngineEvent.
    expect(source).not.toContain('handleEngineEvent')
  })

  // ─── DB-3 guard: dead handleMessageEvents removed; no false tab-type gate ──
  it('engine-event-slice-messages no longer ships dead handleMessageEvents or a tabHasExtensions gate (DB-3)', async () => {
    // handleMessageEvents was dead (no live caller) and its file header
    // documented an "extension-hosted tabs only / after the tabHasExtensions
    // guard" invariant that is FALSE post-unification — engine_* events flow
    // through the normalized stream for any tabId, so plain tabs with
    // dispatched sub-agents receive them too. The dead function + false-invariant
    // docs were removed. If either returns, this goes red.
    const fs = await import('fs')
    const path = await import('path')
    const modPath = path.resolve(__dirname, '../slices/engine-event-slice-messages.ts')
    const source = fs.readFileSync(modPath, 'utf8')
    // The dead handler is gone.
    expect(source).not.toContain('handleMessageEvents')
    // No tab-type gate is referenced (the module's events are tab-type-agnostic).
    expect(source).not.toContain('tabHasExtensions')
    // The live cross-cutting handler is still exported.
    expect(source).toContain('export function handleCrossNormalizedEvent')
  })
})

// ─── Parity test harness ───────────────────────────────────────────────────────

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [],
    statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
    lastMessagePreview: null,
  }
}

function buildStore(isExtensionTab: boolean) {
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [{
      id: 'tab1',
      engineProfileId: isExtensionTab ? 'ext-profile' : null,
      status: 'running',
      lastEventAt: 0,
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      permissionMode: 'auto',
      currentActivity: '',
      conversationId: null,
      lastResult: null,
      sessionTools: [],
      sessionMcpServers: [],
      sessionSkills: [],
      sessionVersion: '',
      activeRequestId: null,
      queuedPrompts: [],
      historicalSessionIds: [],
      isCompacting: false,
      hasUnread: false,
      groupId: null,
      groupPinned: false,
      customTitle: null,
      pillColor: null,
      pillIcon: null,
      title: isExtensionTab ? 'Ext Tab' : 'Plain Tab',
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

// ─── Parity test ───────────────────────────────────────────────────────────────

describe('WI-001 parity: plain tab and extension-hosted tab produce identical state', () => {
  /**
   * Feed the same event sequence to both tab types and assert the resulting
   * conversation state (messages, status, agent states) is identical.
   */

  it('identical text + session_init + agent_state + task_complete sequence produces identical state', () => {
    const plain = buildStore(false)
    const extension = buildStore(true)

    const events: any[] = [
      { type: 'session_init', sessionId: 'sess-1', model: 'claude-sonnet-4-6', tools: [], mcpServers: [], skills: [], version: '1.0', isWarmup: false },
      { type: 'text_chunk', text: 'Hello ' },
      { type: 'text_chunk', text: 'world' },
      { type: 'agent_state', agents: [{ name: 'research', status: 'running', conversationId: 'conv-a' }] },
      { type: 'message_end', inputTokens: 100 },
      { type: 'agent_state', agents: [{ name: 'research', status: 'done', conversationId: 'conv-a' }] },
      { type: 'task_complete', sessionId: 'sess-1', costUsd: 0.01, durationMs: 2000, numTurns: 1, permissionDenials: [] },
    ]

    for (const event of events) {
      plain.slice.handleNormalizedEvent('tab1', event)
      extension.slice.handleNormalizedEvent('tab1', event)
    }

    const plainInst = activeInstance(plain.state.conversationPanes, 'tab1')
    const extInst = activeInstance(extension.state.conversationPanes, 'tab1')

    // Messages must be identical.
    expect(plainInst?.messages.length).toBe(extInst?.messages.length)
    const plainMsgs = plainInst?.messages ?? []
    const extMsgs = extInst?.messages ?? []
    for (let i = 0; i < plainMsgs.length; i++) {
      expect(plainMsgs[i].role).toBe(extMsgs[i].role)
      expect(plainMsgs[i].content).toBe(extMsgs[i].content)
    }

    // Status must be identical.
    expect(plain.state.tabs[0].status).toBe(extension.state.tabs[0].status)
    expect(plain.state.tabs[0].status).toBe('completed')

    // Agent states must be identical.
    expect(plainInst?.agentStates).toEqual(extInst?.agentStates)
    expect(plainInst?.agentStates[0]?.status).toBe('done')
  })

  it('plan_mode events produce identical instance.permissionMode + planFilePath', () => {
    const plain = buildStore(false)
    const extension = buildStore(true)

    const events: any[] = [
      { type: 'engine_plan_mode_changed', planModeEnabled: true, planFilePath: '/tmp/plan.md', planSlug: 'my-plan' },
      { type: 'plan_mode_auto_exit', stopReason: 'end_turn' },
    ]

    for (const event of events) {
      plain.slice.handleNormalizedEvent('tab1', event)
      extension.slice.handleNormalizedEvent('tab1', event)
    }

    const plainInst = activeInstance(plain.state.conversationPanes, 'tab1')
    const extInst = activeInstance(extension.state.conversationPanes, 'tab1')

    expect(plainInst?.permissionMode).toBe(extInst?.permissionMode)
    // After entering plan mode and an auto-exit proposal, the instance stays
    // 'plan' until the user approves (ADR-003). plan_mode_auto_exit is a
    // proposal, not a state flip — event-slice-extension-surface.ts deliberately
    // does NOT reset permissionMode, enforced by engine-event-slice-plan-auto-exit.test.ts.
    expect(plainInst?.permissionMode).toBe('plan')
    expect(plainInst?.planFilePath).toBe(extInst?.planFilePath)

    // Neither parent tab.permissionMode should be written (sticky-parent invariant).
    expect(plain.state.tabs[0].permissionMode).toBe(extension.state.tabs[0].permissionMode)
    expect(plain.state.tabs[0].permissionMode).toBe('auto')
  })

  it('text sealing via message_end works identically for both tab types', () => {
    const plain = buildStore(false)
    const extension = buildStore(true)

    const events: any[] = [
      { type: 'text_chunk', text: 'The answer is 42.' },
      { type: 'message_end', inputTokens: 50 },
    ]

    for (const event of events) {
      plain.slice.handleNormalizedEvent('tab1', event)
      extension.slice.handleNormalizedEvent('tab1', event)
    }

    const plainInst = activeInstance(plain.state.conversationPanes, 'tab1')
    const extInst = activeInstance(extension.state.conversationPanes, 'tab1')

    const plainAsst = plainInst?.messages.find((m: any) => m.role === 'assistant')
    const extAsst = extInst?.messages.find((m: any) => m.role === 'assistant')

    expect(plainAsst?.sealed).toBe(true)
    expect(extAsst?.sealed).toBe(true)
    expect(plainAsst?.content).toBe(extAsst?.content)
  })
})
