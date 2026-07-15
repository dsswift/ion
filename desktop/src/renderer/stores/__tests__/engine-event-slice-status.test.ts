/**
 * status — desktop-internal per-session StatusFields snapshot (root-cause fix
 * for the dead engine StatusBar slots).
 *
 * The control plane forwards every engine_status as a normalized `status` event
 * carrying the full StatusFields. The renderer arm (event-slice-extension-
 * surface.ts) REPLACES inst.statusFields wholesale (snapshot semantics, like
 * agent_state). Before this arm existed, no event ever wrote inst.statusFields,
 * so it stayed null forever and the StatusBar engine slots (identity, cost,
 * backend badge) and the model-picker actual-model parenthetical rendered
 * nothing.
 *
 * Regression assertion: the first test ("populates inst.statusFields") is RED on
 * unfixed code — handleNormalizedEvent has no `status` arm, so statusFields stays
 * null — and GREEN after the fix.
 *
 * Harness mirrors engine-event-slice-agent-state.test.ts (same directory): stub
 * the helpers/preferences, build a single-instance pane, drive
 * handleNormalizedEvent against a fixed state, read back via activeInstance.
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

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'
import type { AgentStateUpdate, StatusFields } from '../../../shared/types-engine'

function makeInstance(id: string) {
  return {
    id, label: id, messages: [], messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [] as AgentStateUpdate[],
    statusFields: null as StatusFields | null, planFilePath: null, thinkingEffort: 'off', sealed: false,
    dispatchTelemetry: [], contextBreakdown: null,
  }
}

function buildHarness() {
  const inst = makeInstance('main')
  const state: any = {
    tabs: [{ id: 'tab1', engineProfileId: 'test-profile', lastEventAt: 0, status: 'running', permissionDenied: null, contextTokens: 0, contextPercent: 0, hasUnread: false, queuedPrompts: [], historicalSessionIds: [], permissionMode: 'auto', activeRequestId: null, currentActivity: null }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [inst], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function getStatusFields(state: any): StatusFields | null | undefined {
  return activeInstance(state.conversationPanes, 'tab1')?.statusFields
}

function fields(overrides: Partial<StatusFields> = {}): StatusFields {
  return {
    label: '',
    state: 'running',
    model: 'claude-sonnet-4-6',
    contextPercent: 0,
    contextWindow: 200_000,
    ...overrides,
  }
}

describe('status snapshot — populates inst.statusFields (root-cause fix)', () => {
  it('populates inst.statusFields from the event payload (REGRESSION)', () => {
    const { state, slice } = buildHarness()
    expect(getStatusFields(state)).toBeNull()

    slice.handleNormalizedEvent('tab1', {
      type: 'status',
      fields: fields({
        state: 'running',
        model: 'claude-opus-4-7',
        runCostUsd: 1.23,
        extensionName: 'Chief of Staff',
        team: 'Platform',
      }),
    } as any)

    const stored = getStatusFields(state)
    expect(stored).toBeDefined()
    expect(stored).not.toBeNull()
    expect(stored!.model).toBe('claude-opus-4-7')
    expect(stored!.runCostUsd).toBe(1.23)
    expect(stored!.extensionName).toBe('Chief of Staff')
    expect(stored!.team).toBe('Platform')
  })

  it('REPLACES the prior snapshot wholesale (no merge)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'status',
      fields: fields({ state: 'running', runCostUsd: 0.5, extensionName: 'First' }),
    } as any)

    // Second snapshot omits extensionName and bumps cost — must replace, not merge.
    slice.handleNormalizedEvent('tab1', {
      type: 'status',
      fields: fields({ state: 'idle', runCostUsd: 0.9 }),
    } as any)

    const stored = getStatusFields(state)
    expect(stored!.state).toBe('idle')
    expect(stored!.runCostUsd).toBe(0.9)
    // extensionName from the first snapshot must NOT survive (wholesale replace).
    expect(stored!.extensionName).toBeUndefined()
  })

  it('writes a new conversationPanes Map (no in-place mutation)', () => {
    const { state, slice } = buildHarness()
    const before = state.conversationPanes

    slice.handleNormalizedEvent('tab1', { type: 'status', fields: fields() } as any)

    expect(state.conversationPanes).not.toBe(before)
  })

  it('is a no-op when tabId does not exist in conversationPanes', () => {
    const { state, slice } = buildHarness()
    const before = state.conversationPanes

    slice.handleNormalizedEvent('nonexistent-tab', { type: 'status', fields: fields() } as any)

    expect(state.conversationPanes).toBe(before)
  })
})
