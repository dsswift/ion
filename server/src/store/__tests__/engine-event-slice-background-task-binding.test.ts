/**
 * background_task_started / tool_result — the two keys that bind a transcript
 * tool row to a live background Bash task.
 *
 * REPORTED: two `make test-linux-*` commands were dispatched with
 * `run_in_background` + `notify_on_complete`. The engine started both, parked
 * the session on them, and emitted every lifecycle event. The conversation
 * showed neither the collapsible background-Bash group nor a pending tool row:
 * both commands rendered as ordinary completed tools the instant they started.
 *
 * BackgroundWorkGroup binds a task to its row on either of two keys, and both
 * were severed:
 *
 *   1. `message.backgroundTaskId`, set from the tool_result event. The engine
 *      dropped the field when assembling the result (fixed in
 *      engine/internal/backend/runloop_tools.go), so the renderer took the
 *      `else` branch and marked the row completed immediately.
 *   2. `task.toolId`, the fallback for first paint — the only key available
 *      before tool_result arrives. The control-plane mapping dropped it, and
 *      this reducer then never stored it.
 *
 * These tests pin the renderer half. The engine half is pinned by
 * TestExecuteToolsPropagatesBackgroundTaskID, and the mapping half by
 * engine-control-plane-background-work.test.ts.
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

const TOOL_ID = 'call_8iNFYklf0rjCXGkzXYH99C2v'
const TASK_ID = 'bash-1-1789041447216'

function buildHarness() {
  const inst: any = {
    id: 'main', label: 'main', messageCount: 0, modelOverride: null, sessionModel: null,
    permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
    conversationIds: [], draftInput: '', agentStates: [], statusFields: null,
    planFilePath: null, thinkingEffort: 'off', sealed: false,
    messages: [{
      id: 'm1', role: 'tool', toolId: TOOL_ID, toolName: 'Bash',
      toolInput: '{"command":"make test-linux-engine"}', toolStatus: 'running',
      content: '', timestamp: 1,
    }],
  }
  const state: any = {
    tabs: [{ id: 'tab1', engineProfileId: 'p', lastEventAt: 0, status: 'running', permissionDenied: null, contextTokens: 0, contextPercent: 0, hasUnread: false, queuedPrompts: [], historicalSessionIds: [], permissionMode: 'auto', activeRequestId: null, currentActivity: null }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [inst], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  const slice = createEventSlice(set, () => state as State) as State
  return { state, slice }
}

const inst = (state: any) => activeInstance(state.conversationPanes, 'tab1')!

describe('background task ↔ tool row binding', () => {
  it('stores the start event toolId so the group can bind before tool_result (REGRESSION)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'background_task_started',
      taskId: TASK_ID,
      toolId: TOOL_ID,
      command: 'make test-linux-engine',
      startedAt: 10,
      notifyOnComplete: true,
    } as any)

    const tasks = inst(state).statusFields?.activeBackgroundTasks
    expect(tasks).toHaveLength(1)
    // Pre-fix this was undefined: the reducer copied taskId/command/startedAt/
    // notifyOnComplete and dropped toolId, leaving BackgroundWorkGroup's
    // `toolByID` fallback nothing to match on at first paint.
    expect(tasks![0].toolId).toBe(TOOL_ID)
  })

  it('keeps the tool row pending and bound when tool_result carries a task id (REGRESSION)', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'tool_result',
      toolId: TOOL_ID,
      content: `Background task started: ${TASK_ID}\nOutput file: /tmp/o.out`,
      isError: false,
      backgroundTaskId: TASK_ID,
    } as any)

    const row = inst(state).messages.find((m: any) => m.toolId === TOOL_ID)!
    expect(row.backgroundTaskId).toBe(TASK_ID)
    // The row must NOT settle to completed: the command is still running, and
    // the terminal lifecycle event is what resolves it. With the engine
    // dropping backgroundTaskId this fell to the `else` branch and every
    // background command rendered as an instantly-finished tool.
    expect(row.toolStatus).toBe('running')
  })

  it('resolves the row and drains the inventory on the terminal event', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'background_task_started', taskId: TASK_ID, toolId: TOOL_ID,
      command: 'make test-linux-engine', startedAt: 10, notifyOnComplete: true,
    } as any)
    slice.handleNormalizedEvent('tab1', {
      type: 'tool_result', toolId: TOOL_ID, content: 'started', isError: false,
      backgroundTaskId: TASK_ID,
    } as any)
    slice.handleNormalizedEvent('tab1', {
      type: 'background_task_terminal', taskId: TASK_ID, status: 'completed',
      exitCode: 0, elapsedMs: 500, command: 'make test-linux-engine',
    } as any)

    expect(inst(state).statusFields?.activeBackgroundTasks).toHaveLength(0)
    const row = inst(state).messages.find((m: any) => m.toolId === TOOL_ID)!
    expect(row.toolStatus).toBe('completed')
    expect(row.backgroundWork?.items[0].taskId).toBe(TASK_ID)
  })
})
