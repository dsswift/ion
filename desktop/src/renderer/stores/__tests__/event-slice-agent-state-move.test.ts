/**
 * agent_state → auto-group re-evaluation (maybeApplyAgentStateGroupMove).
 *
 * TWO REGRESSIONS CLOSED:
 *
 * Bug A — premature done-move: the orchestrator went idle while a fast
 * background dispatch ran start→done within the 1500ms timer window (or the
 * child's `running` snapshot arrived after the timer fired). The tab ended up
 * in the done group while the child was still running. When the next
 * agent_state snapshot arrives showing running children, the tab must move
 * BACK to in-progress immediately.
 *
 * Bug B — stranded in-progress: the orchestrator went idle with a running
 * child so maybeScheduleDoneMove was suppressed. The child finishes and
 * agent_state arrives with all children terminal. Nobody re-evaluates the
 * done-move. The tab stays in in-progress forever.
 *
 * Each regression test goes RED if the maybeApplyAgentStateGroupMove call
 * is removed from the event-slice agent_state post-commit block.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const prefs = {
  expandToolResults: false,
  aiGeneratedTitles: false,
  autoGroupMovement: true,
  tabGroupMode: 'manual',
  doneGroupId: 'group-done',
  inProgressGroupId: 'group-inprogress',
  planningGroupId: 'group-planning',
}

// Capture the scheduled done-move callback so the test can fire it after the
// reducer commits (same pattern as event-slice-done-move.test.ts).
let scheduledMove: (() => void) | null = null
const cancelDoneGroupMoveMock = vi.fn(() => false)

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn((_tabId: string, _delay: number, cb: () => void) => {
    scheduledMove = cb
  }),
  cancelDoneGroupMove: (...args: unknown[]) => cancelDoneGroupMoveMock(...(args as [])),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => prefs },
}))

vi.mock('../../lib/window-role', () => ({ isMirrorWindow: vi.fn(() => false) }))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane } from './helpers/conversation-test-helpers'
import type { AgentStateUpdate } from '../../../shared/types-engine'
import { isMirrorWindow } from '../../lib/window-role'

// Minimal running/done agent fixtures
const runningAgent: AgentStateUpdate = { name: 'dev-lead', status: 'running', metadata: {} }
const doneAgent: AgentStateUpdate = { name: 'dev-lead', status: 'done', metadata: {} }

function makeTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tab1',
    title: 'Orchestrator',
    engineProfileId: 'cos',
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: 'group-inprogress',
    groupPinned: false,
    status: 'idle' as const,
    customTitle: null,
    pillColor: null,
    permissionMode: 'auto' as const,
    queuedPrompts: [],
    historicalSessionIds: [],
    conversationId: 'conv-1',
    lastKnownSessionId: 'conv-1',
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: '',
    activeRequestId: null,
    currentActivity: '',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
    ...overrides,
  }
}

function buildHarness(opts: {
  instanceMode?: 'auto' | 'plan'
  agentStates?: AgentStateUpdate[]
  tabOverrides?: Record<string, unknown>
} = {}) {
  const moveTabToGroup = vi.fn()
  const conversationPanes = seedMainPane('tab1', {
    permissionMode: opts.instanceMode ?? 'auto',
    agentStates: opts.agentStates ?? [],
    sessionModel: 'mock-model',
  })
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab(opts.tabOverrides)],
    conversationPanes,
    backend: 'api',
    moveTabToGroup,
    submit: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice, moveTabToGroup }
}

beforeEach(() => {
  scheduledMove = null
  cancelDoneGroupMoveMock.mockClear()
  vi.mocked(isMirrorWindow).mockReturnValue(false)
})

describe('event-slice — agent_state auto-group re-evaluation', () => {
  /**
   * BUG B REGRESSION — Bug B: orchestrator went idle with running child
   * (done-move suppressed). Child finishes → agent_state all-terminal.
   * Tab is idle in in-progress group → done-move must be scheduled.
   *
   * Goes RED if the maybeApplyAgentStateGroupMove call is removed from
   * the agent_state post-commit block in event-slice.ts.
   */
  it('BUG B: schedules done-move when all agents finish and tab is idle in in-progress', () => {
    scheduledMove = null
    const { slice, moveTabToGroup } = buildHarness({
      // Tab is idle in in-progress (orchestrator finished, child held it back)
      tabOverrides: { status: 'idle', groupId: 'group-inprogress' },
      // No running children in store at event time (snapshot arrives all-done)
      agentStates: [],
    })

    // Deliver agent_state with all agents done
    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [doneAgent] } as any)

    // Done-move must have been scheduled (prevStatus='running' synthetic)
    expect(scheduledMove).not.toBeNull()

    // Fire the timer — no running tab / no running children → move executes
    scheduledMove!()
    expect(moveTabToGroup).toHaveBeenCalledWith('tab1', 'group-done')
  })

  /**
   * BUG B — empty agents array (all-terminal edge case): empty snapshot also
   * means "no running children". Same expected outcome as all-done.
   */
  it('BUG B: schedules done-move for empty agents array when tab is idle', () => {
    scheduledMove = null
    const { slice, moveTabToGroup } = buildHarness({
      tabOverrides: { status: 'idle', groupId: 'group-inprogress' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [] } as any)

    expect(scheduledMove).not.toBeNull()
    scheduledMove!()
    expect(moveTabToGroup).toHaveBeenCalledWith('tab1', 'group-done')
  })

  /**
   * BUG B — already in done group: agent_state all-terminal but tab is
   * already in done group. maybeScheduleDoneMove's "not already in done group"
   * guard must suppress the redundant schedule.
   */
  it('BUG B: no-op when all agents done but tab is already in done group', () => {
    scheduledMove = null
    const { slice, moveTabToGroup } = buildHarness({
      tabOverrides: { status: 'idle', groupId: 'group-done' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [doneAgent] } as any)

    // No move scheduled (already in done group)
    expect(scheduledMove).toBeNull()
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  /**
   * BUG A REGRESSION — Bug A: tab was moved to done group while a fast child
   * completed within the 1500ms timer window (or snapshot arrived after timer).
   * Now agent_state arrives showing a running child while tab is in done group.
   * Tab must move BACK to in-progress immediately and pending timer cancelled.
   *
   * Goes RED if the maybeApplyAgentStateGroupMove call is removed.
   */
  it('BUG A: moves tab back to in-progress when running child found in done group', () => {
    const { slice, moveTabToGroup } = buildHarness({
      // Tab is idle (orchestrator finished) but erroneously in done group
      tabOverrides: { status: 'idle', groupId: 'group-done' },
      agentStates: [],
    })

    // Deliver agent_state showing a running child
    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [runningAgent] } as any)

    // cancelDoneGroupMove must have been called to clear any pending timer
    expect(cancelDoneGroupMoveMock).toHaveBeenCalledWith('tab1')
    // Tab moved back to in-progress
    expect(moveTabToGroup).toHaveBeenCalledWith('tab1', 'group-inprogress')
  })

  /**
   * BUG A — already in in-progress: running child arrives but tab is already
   * in in-progress group. applyActiveGroupMove's "not already in group" guard
   * must suppress the redundant move.
   */
  it('BUG A: no-op when running child arrives but tab is already in in-progress', () => {
    const { slice, moveTabToGroup } = buildHarness({
      tabOverrides: { status: 'idle', groupId: 'group-inprogress' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [runningAgent] } as any)

    // No move (already in the right group)
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  /**
   * Plan mode: instance permission mode is 'plan'. applyActiveGroupMove maps
   * plan-mode to planningGroupId. A running child in done group must move the
   * tab to the PLANNING group, not in-progress.
   */
  it('BUG A: moves to planning group when instance is plan mode', () => {
    const { slice, moveTabToGroup } = buildHarness({
      instanceMode: 'plan',
      tabOverrides: { status: 'idle', groupId: 'group-done' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [runningAgent] } as any)

    expect(moveTabToGroup).toHaveBeenCalledWith('tab1', 'group-planning')
  })

  /**
   * Not auto mode (instance mode = 'plan') + all children done: the done-move
   * helper's effectivePermissionMode guard blocks moves for plan-mode tabs
   * (they are awaiting approval, not "done").
   */
  it('BUG B: no done-move when instance is plan mode (awaiting approval)', () => {
    scheduledMove = null
    const { slice, moveTabToGroup } = buildHarness({
      instanceMode: 'plan',
      tabOverrides: { status: 'idle', groupId: 'group-inprogress' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [doneAgent] } as any)

    // maybeScheduleDoneMove bails on mode !== 'auto'
    expect(scheduledMove).toBeNull()
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  /**
   * Pinned tab: running child in done group but tab is pinned.
   * applyActiveGroupMove suppresses moves on pinned tabs.
   */
  it('BUG A: suppressed when tab is pinned', () => {
    const { slice, moveTabToGroup } = buildHarness({
      tabOverrides: { status: 'idle', groupId: 'group-done', groupPinned: true },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [runningAgent] } as any)

    expect(moveTabToGroup).not.toHaveBeenCalled()
  })

  /**
   * Mirror window: the ATV mirror receives the same event stream. The mirror
   * guard must prevent duplicate group moves originating from the mirror.
   */
  it('skipped entirely when in mirror window', () => {
    vi.mocked(isMirrorWindow).mockReturnValue(true)
    const { slice, moveTabToGroup } = buildHarness({
      tabOverrides: { status: 'idle', groupId: 'group-done' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [runningAgent] } as any)

    expect(moveTabToGroup).not.toHaveBeenCalled()
    expect(cancelDoneGroupMoveMock).not.toHaveBeenCalled()
  })

  /**
   * Tab still running (not terminal): all agents done but orchestrator itself
   * is still running (e.g. processing a follow-up turn). No done-move.
   */
  it('BUG B: no done-move when tab is still running even if agents all done', () => {
    scheduledMove = null
    const { slice, moveTabToGroup } = buildHarness({
      tabOverrides: { status: 'running', groupId: 'group-inprogress' },
      agentStates: [],
    })

    slice.handleNormalizedEvent!('tab1', { type: 'agent_state', agents: [doneAgent] } as any)

    expect(scheduledMove).toBeNull()
    expect(moveTabToGroup).not.toHaveBeenCalled()
  })
})
