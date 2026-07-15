/**
 * Regression: restored/migrated engine tab instance id must be MAIN_INSTANCE_ID
 * (#256 Defect 1 — WI-001 normalized path).
 *
 * After the single-path collapse (WI-001), all engine events flow through
 * handleNormalizedEvent (event-slice.ts) keyed by bare tabId and landing on
 * the active instance. This test pins the same instance-id normalization
 * contract that was verified via handleEngineEvent in the pre-WI-001 code:
 *
 *   - If the active instance id is 'main' (MAIN_INSTANCE_ID), events land.
 *   - If the active instance id is a UUID (pre-fix restore shape), events are
 *     dropped because activeInstance() looks for activeInstanceId matching the
 *     stored instances. If activeInstanceId is a UUID and the instance id is
 *     also a UUID, but we call handleNormalizedEvent('tab1', ...), the lookup
 *     via activeInstance(panes, tabId) finds the active instance regardless of
 *     its id — it uses pane.activeInstanceId to look up pane.instances. So the
 *     pre-fix contract for "UUID instance drops events" ONLY applies in the
 *     old path where parseSessionKey was used.
 *
 * WI-001 change: the new activeInstance() helper is used everywhere and it
 * looks up instances by pane.activeInstanceId, so events land on the correct
 * instance regardless of the id string. The regression that needed "UUID
 * instance id drops events" no longer exists in the normalized path.
 *
 * This test retains the "events land on the active instance via bare tabId"
 * assertions and updates the "UUID instance" assertion to reflect WI-001
 * behavior (activeInstance still finds it by pane.activeInstanceId).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'

// The slice's session_init branch may reach for `window` to flush persistence;
// stub it so node-vitest doesn't throw on the lookup.
beforeAll(() => {
  ;(globalThis as any).window = (globalThis as any).window || {}
})

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, autoGroupMovement: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'

const UUID_ID = '3f9c1e02-7a44-4b21-9c0e-aa11bb22cc33'

function makeInstance(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    messages: [],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    thinkingEffort: 'off',
    sealed: false,
    dispatchTelemetry: [],
    contextBreakdown: null,
    ...overrides,
  }
}

function buildHarness(opts: { activeInstanceId: string; instances: any[] }) {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'test-profile',
      status: 'connecting',
      conversationId: null,
      lastKnownSessionId: null,
      historicalSessionIds: [],
      lastEventAt: 0,
      permissionMode: 'auto',
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      activeRequestId: null,
      currentActivity: null,
      sessionTools: [],
      sessionMcpServers: [],
      sessionSkills: [],
      sessionVersion: '',
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: opts.instances, activeInstanceId: opts.activeInstanceId }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

const BARE_KEY = 'tab1'

describe('restore instance-id normalization (#256 Defect 1 — WI-001 path)', () => {
  describe("normalized 'main' instance — bare-key events land (the fix)", () => {
    it('session_init updates tab.conversationId and advances status off connecting', () => {
      const { state, slice } = buildHarness({
        activeInstanceId: MAIN_INSTANCE_ID,
        instances: [makeInstance(MAIN_INSTANCE_ID)],
      })

      slice.handleNormalizedEvent(BARE_KEY, {
        type: 'session_init',
        sessionId: 'conv-live-1',
        model: 'claude-4',
        tools: [],
        mcpServers: [],
        skills: [],
        version: '1',
        isWarmup: false,
      } as any)

      expect(state.tabs[0].conversationId).toBe('conv-live-1')
      expect(state.tabs[0].status).toBe('running')
    })

    it('session_init sessionId accumulates into the active instance conversationIds', () => {
      const { state, slice } = buildHarness({
        activeInstanceId: MAIN_INSTANCE_ID,
        instances: [makeInstance(MAIN_INSTANCE_ID)],
      })

      slice.handleNormalizedEvent(BARE_KEY, {
        type: 'session_init',
        sessionId: 'conv-live-2',
        model: '',
        tools: [],
        mcpServers: [],
        skills: [],
        version: '1',
        isWarmup: false,
      } as any)

      const inst = activeInstance(state.conversationPanes, 'tab1')
      expect(inst?.conversationIds).toContain('conv-live-2')
    })

    it('agent_state lands on the active instance (bare tabId)', () => {
      const { state, slice } = buildHarness({
        activeInstanceId: MAIN_INSTANCE_ID,
        instances: [makeInstance(MAIN_INSTANCE_ID)],
      })

      slice.handleNormalizedEvent(BARE_KEY, {
        type: 'agent_state',
        agents: [{ name: 'dev-lead', status: 'running' }],
      } as any)

      const inst = activeInstance(state.conversationPanes, 'tab1')
      expect(inst?.agentStates).toHaveLength(1)
      expect(inst?.agentStates[0].name).toBe('dev-lead')
    })
  })

  describe('UUID-id instance — WI-001 still finds it via pane.activeInstanceId', () => {
    // WI-001 change: activeInstance() uses pane.activeInstanceId to find the
    // instance. It does not use parseSessionKey. So events land on any active
    // instance regardless of whether its id is 'main' or a UUID.
    // The pre-fix UUID-drops-events behavior was specific to the old path.
    it('agent_state DOES land on a UUID-id active instance in WI-001 path', () => {
      const { state, slice } = buildHarness({
        activeInstanceId: UUID_ID,
        instances: [makeInstance(UUID_ID)],
      })

      slice.handleNormalizedEvent(BARE_KEY, {
        type: 'agent_state',
        agents: [{ name: 'dev-lead', status: 'running' }],
      } as any)

      // WI-001: activeInstance(panes, tabId) → pane.activeInstanceId → UUID_ID
      // → finds the instance. Events land.
      const inst = activeInstance(state.conversationPanes, 'tab1')
      expect(inst?.agentStates).toHaveLength(1)
      expect(inst?.agentStates[0].name).toBe('dev-lead')
    })

    it('session_init DOES capture conversationId on a UUID-id active instance', () => {
      const { state, slice } = buildHarness({
        activeInstanceId: UUID_ID,
        instances: [makeInstance(UUID_ID)],
      })

      slice.handleNormalizedEvent(BARE_KEY, {
        type: 'session_init',
        sessionId: 'conv-x',
        model: '',
        tools: [],
        mcpServers: [],
        skills: [],
        version: '1',
        isWarmup: false,
      } as any)

      const inst = activeInstance(state.conversationPanes, 'tab1')
      expect(inst?.conversationIds).toContain('conv-x')
    })
  })
})
