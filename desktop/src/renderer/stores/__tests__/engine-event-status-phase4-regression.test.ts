/**
 * Phase 4 regression tests for `handleEngineStatusEvent`.
 *
 * Phase 4 of the state-management overhaul removes the renderer's
 * inferred-status writers (engine_text_delta no longer sets
 * `tab.status='running'`) and may delete the active-instance status
 * mutation block in engine-event-status.ts. These tests lock down the
 * surrounding behavior that MUST continue to work:
 *
 *   - sessionId capture into instance.conversationIds (persistence)
 *   - model capture into instance.modelOverride
 *   - permissionDenied promotion (AskUserQuestion / ExitPlanMode)
 *   - cost/context merge into statusFields
 *   - context-percent backfill from engineUsage map
 *   - model-fallback indicator clear-on-idle
 *   - permissionDenied preservation on cost-only ticks
 *
 * If Phase 4 (or a future refactor) breaks any of these, the failure
 * will surface here and not by an iOS-side regression that's harder to
 * diagnose.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'

// The slice's didCaptureNewSessionId branch calls into `window` to
// force-flush the persistence layer. Stub it so node-vitest does not
// throw on the global lookup; the function itself does not need to do
// anything for these tests (we observe state mutations directly).
beforeAll(() => {
  (globalThis as any).window = (globalThis as any).window || {}
})

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import type { State } from '../session-store-types'

function makeInstance(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    messages: [],
    modelOverride: null,
    permissionMode: 'auto',
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    ...overrides,
  }
}

function buildHarness(opts: { tabStatus?: string; activeInstanceId?: string; instances?: any[] } = {}) {
  const state: any = {
    tabs: [
      {
        id: 'tab1',
        isEngine: true,
        status: opts.tabStatus ?? 'idle',
        conversationId: undefined,
        lastKnownSessionId: undefined,
        lastEventAt: 0,
        permissionDenied: null,
      },
    ],
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    enginePanes: new Map([[
      'tab1',
      {
        instances: opts.instances ?? [makeInstance('inst1')],
        activeInstanceId: opts.activeInstanceId ?? 'inst1',
      },
    ]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

function getInstance(state: any, tabId: string, instanceId: string) {
  return state.enginePanes.get(tabId)?.instances.find((i: any) => i.id === instanceId)
}

describe('engine_status — Phase 4 regression: behaviors that survive the refactor', () => {
  it('captures sessionId into instance.conversationIds (persistence-critical)', () => {
    const { state, slice } = buildHarness()
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: {
        state: 'idle',
        sessionId: 'conv-abc-123',
        label: 'inst1',
        model: 'claude-4',
        contextPercent: 10,
        contextWindow: 200000,
      },
    } as any)

    const inst = getInstance(state, 'tab1', 'inst1')
    expect(inst?.conversationIds).toEqual(['conv-abc-123'])
  })

  it('appends additional sessionIds rather than replacing', () => {
    const { state, slice } = buildHarness({
      instances: [makeInstance('inst1', { conversationIds: ['conv-old'] })],
    })
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', sessionId: 'conv-new', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    const inst = getInstance(state, 'tab1', 'inst1')
    expect(inst?.conversationIds).toEqual(['conv-old', 'conv-new'])
  })

  it('does not duplicate the most recent sessionId on repeated ticks', () => {
    const { state, slice } = buildHarness({
      instances: [makeInstance('inst1', { conversationIds: ['conv-x'] })],
    })
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', sessionId: 'conv-x', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    const inst = getInstance(state, 'tab1', 'inst1')
    expect(inst?.conversationIds).toEqual(['conv-x'])
  })

  it('captures valid model into instance.modelOverride and rejects "unknown"', () => {
    const { state, slice } = buildHarness()

    // Valid model: captured
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: 'claude-4', contextPercent: 0, contextWindow: 0 },
    } as any)
    expect(getInstance(state, 'tab1', 'inst1')?.modelOverride).toBe('claude-4')

    // Bogus "unknown" model: rejected — modelOverride must not regress.
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: 'unknown', contextPercent: 0, contextWindow: 0 },
    } as any)
    expect(getInstance(state, 'tab1', 'inst1')?.modelOverride).toBe('claude-4')
  })

  it('promotes AskUserQuestion denial into instance.permissionDenied', () => {
    const { state, slice } = buildHarness()
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: {
        state: 'idle',
        label: '',
        model: '',
        contextPercent: 0,
        contextWindow: 0,
        permissionDenials: [
          { toolName: 'AskUserQuestion', toolUseId: 'tu-1', toolInput: { question: 'pick?' } },
        ],
      },
    } as any)

    const pd = getInstance(state, 'tab1', 'inst1')?.permissionDenied
    expect(pd?.tools).toHaveLength(1)
    expect(pd?.tools[0].toolName).toBe('AskUserQuestion')
  })

  it('promotes ExitPlanMode denial into instance.permissionDenied', () => {
    const { state, slice } = buildHarness()
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: {
        state: 'idle',
        label: '',
        model: '',
        contextPercent: 0,
        contextWindow: 0,
        permissionDenials: [
          { toolName: 'ExitPlanMode', toolUseId: 'tu-2' },
        ],
      },
    } as any)

    const pd = getInstance(state, 'tab1', 'inst1')?.permissionDenied
    expect(pd?.tools[0].toolName).toBe('ExitPlanMode')
  })

  it('preserves existing permissionDenied on a cost-only follow-up tick (idempotence)', () => {
    const { state, slice } = buildHarness({
      instances: [makeInstance('inst1', {
        permissionDenied: { tools: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-1' }] },
      })],
    })

    // Cost-only tick with no denials in the payload.
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: 'claude-4', contextPercent: 42, contextWindow: 200000, totalCostUsd: 0.15 },
    } as any)

    const pd = getInstance(state, 'tab1', 'inst1')?.permissionDenied
    expect(pd?.tools).toHaveLength(1)
    expect(pd?.tools[0].toolName).toBe('AskUserQuestion')
  })

  it('merges contextPercent backfill from engineUsage when fields omit it', () => {
    const { state, slice } = buildHarness()
    state.engineUsage.set('tab1:inst1', { percent: 73, inputTokens: 1, outputTokens: 1 })

    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    const sf = getInstance(state, 'tab1', 'inst1')?.statusFields
    expect(sf?.contextPercent).toBe(73)
  })

  it('merges totalCostUsd from prior statusFields when payload omits it', () => {
    const { state, slice } = buildHarness({
      instances: [makeInstance('inst1', {
        statusFields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0, totalCostUsd: 0.42 },
      })],
    })

    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    expect(getInstance(state, 'tab1', 'inst1')?.statusFields?.totalCostUsd).toBe(0.42)
  })

  it('clears engineModelFallbacks entry on the idle transition', () => {
    const { state, slice } = buildHarness()
    state.engineModelFallbacks.set('tab1:inst1', { requestedModel: 'opus-9', fallbackModel: 'claude-4' })

    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    expect(state.engineModelFallbacks.has('tab1:inst1')).toBe(false)
  })

  it('preserves engineModelFallbacks entry on a running emission (no clear)', () => {
    const { state, slice } = buildHarness()
    state.engineModelFallbacks.set('tab1:inst1', { requestedModel: 'opus-9', fallbackModel: 'claude-4' })

    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'running', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    expect(state.engineModelFallbacks.has('tab1:inst1')).toBe(true)
  })
})

describe('engine_status — Phase 4 contract: status mutation behavior', () => {
  it('still sets tab.status=running when active instance reports running', () => {
    const { state, slice } = buildHarness({ tabStatus: 'idle' })
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'running', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)
    expect(state.tabs[0].status).toBe('running')
  })

  it('sets tab.status=completed when active instance reports idle + AskUserQuestion denial', () => {
    const { state, slice } = buildHarness({ tabStatus: 'running' })
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: {
        state: 'idle',
        label: '',
        model: '',
        contextPercent: 0,
        contextWindow: 0,
        permissionDenials: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-1' }],
      },
    } as any)
    expect(state.tabs[0].status).toBe('completed')
  })

  it('sets tab.status=idle when active instance idle and no denials', () => {
    const { state, slice } = buildHarness({ tabStatus: 'running' })
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)
    expect(state.tabs[0].status).toBe('idle')
  })

  it('keeps tab.status=running when idle but backgroundAgents > 0', () => {
    const { state, slice } = buildHarness({ tabStatus: 'running' })
    slice.handleEngineEvent('tab1:inst1', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0, backgroundAgents: 2 },
    } as any)
    // Background dispatches: tab remains 'running' so the interrupt button stays visible.
    expect(state.tabs[0].status).toBe('running')
  })

  it('does NOT mutate parent tab.status when the event arrives for an inactive sub-instance', () => {
    // This is the Bug 1 case from the original plan. The active-instance
    // gate intentionally drops status updates from inactive instances so
    // a background sub-conversation can't overwrite the foreground pill.
    // The snapshot derivation (Phase 1 commit 85647b95) corrects this on
    // the iOS-facing surface. Phase 4 preserves the renderer-side gate.
    const { state, slice } = buildHarness({
      tabStatus: 'running',
      activeInstanceId: 'inst-active',
      instances: [makeInstance('inst-active'), makeInstance('inst-inactive')],
    })

    // Inactive instance reports idle — should not bump parent tab.status.
    slice.handleEngineEvent('tab1:inst-inactive', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: '', contextPercent: 0, contextWindow: 0 },
    } as any)

    expect(state.tabs[0].status).toBe('running')
  })

  it('always writes statusFields on the targeted instance, regardless of active-instance gate', () => {
    // Even when the active-instance gate blocks tab.status mutation, the
    // per-instance statusFields must still update so the snapshot
    // derivation sees fresh state for the inactive sub-tab.
    const { state, slice } = buildHarness({
      activeInstanceId: 'inst-active',
      instances: [makeInstance('inst-active'), makeInstance('inst-inactive')],
    })

    slice.handleEngineEvent('tab1:inst-inactive', {
      type: 'engine_status',
      fields: { state: 'idle', label: '', model: 'claude-4', contextPercent: 5, contextWindow: 200000 },
    } as any)

    const inactive = getInstance(state, 'tab1', 'inst-inactive')
    expect(inactive?.statusFields?.state).toBe('idle')
    expect(inactive?.statusFields?.model).toBe('claude-4')
  })
})
