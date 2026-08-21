/**
 * The Plan Ready card must survive lifecycle noise that is not the user
 * answering it.
 *
 * REGRESSION (reported live): a conversation called ExitPlanMode, the engine
 * emitted the proposal, and the desktop synthesized the approval card — then
 * the card was gone ~130ms later and never came back. The tab showed "Done"
 * instead of "Plan Ready" and there was no button to click. The plan file was
 * intact on disk; only the state was lost.
 *
 * Timeline from desktop.jsonl for the affected tab:
 *   .470  engine exit_tool                       (proposal emitted)
 *   .488  "synthesized ExitPlanMode ... denied"   (card exists)
 *   .618  task_complete synthesized, denials: 1
 *   .623  renderer "task complete" prev_status: "connecting"
 *   .682  load_conversation → "session active, pushing live state"
 * A conversation load raced the finishing run, and the `session_init` arm
 * nulled `permissionDenied` unconditionally on the way to 'running'.
 *
 * Why this is high severity rather than cosmetic: `permissionDenied` is the
 * SINGLE field every waiting-state surface reads through
 * `waitingStateOfPane` (TabStripShared.ts) — the approval card, the tab status
 * dot, the group pill, the workspace indicator, the Studio inbox row label and
 * the iOS projection. Nulling it blanks all of them at once, with no user
 * action and no record of why.
 *
 * Revert contract: restoring `instPatch.permissionDenied = null` unconditionally
 * in the session_init arm makes the first two tests go red. Reverting the
 * heartbeat reconciliation in event-slice-extension-surface.ts makes the
 * "restores a lost card" test go red.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
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
      planningGroupId: null,
    }),
  },
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

const PLAN_DENIAL = {
  tools: [
    {
      toolName: 'ExitPlanMode',
      toolUseId: 'plan-proposal-tab1',
      toolInput: { planFilePath: '/Users/x/.ion/plans/tidy-mixing-brook.md' },
    },
  ],
}

const RUN_DENIAL = { tools: [{ toolName: 'Bash', toolUseId: 'tu-bash' }] }

function makeTab(status: string, activeRequestId: string | null) {
  return {
    id: 'tab1',
    title: 'Conversation',
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: null,
    groupPinned: false,
    status,
    customTitle: null,
    pillColor: null,
    permissionMode: 'plan' as const,
    queuedPrompts: [],
    historicalSessionIds: [],
    conversationId: 'conv-1',
    lastKnownSessionId: 'conv-1',
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: '',
    activeRequestId,
    currentActivity: '',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
  }
}

function buildHarness(opts: {
  status: string
  activeRequestId?: string | null
  permissionDenied?: unknown
}) {
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab(opts.status, opts.activeRequestId ?? null)],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'plan',
      sessionModel: 'claude-opus',
      planFilePath: '/Users/x/.ion/plans/tidy-mixing-brook.md',
      permissionDenied: (opts.permissionDenied ?? null) as any,
    }),
    backend: 'api',
    engineModelFallbacks: new Map(),
    moveTabToGroup: vi.fn(),
    submit: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function sessionInit() {
  return {
    type: 'session_init',
    sessionId: 'conv-1',
    tools: [],
    model: 'claude-opus',
    mcpServers: [],
    skills: [],
    version: '',
    isWarmup: false,
  } as any
}

/** An idle heartbeat carrying the engine's retained (unresolved) denials. */
function idleStatus(permissionDenials?: unknown) {
  return {
    type: 'status',
    fields: {
      state: 'idle',
      sessionId: 'conv-1',
      ...(permissionDenials ? { permissionDenials } : {}),
    },
  } as any
}

describe('plan card survival — session_init', () => {
  it('PRESERVES a pending ExitPlanMode card when session_init races the proposal (the bug)', () => {
    // The exact reported sequence: the proposal card exists, then a
    // conversation load pushes live state on the still-active run.
    const { state, slice } = buildHarness({
      status: 'connecting',
      activeRequestId: 'req-1',
      permissionDenied: PLAN_DENIAL,
    })

    slice.handleNormalizedEvent!('tab1', sessionInit())

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toEqual(PLAN_DENIAL)
  })

  it('PRESERVES a pending AskUserQuestion card across session_init', () => {
    const ASK = { tools: [{ toolName: 'AskUserQuestion', toolUseId: 'tu-ask' }] }
    const { state, slice } = buildHarness({
      status: 'connecting',
      activeRequestId: 'req-1',
      permissionDenied: ASK,
    })

    slice.handleNormalizedEvent!('tab1', sessionInit())

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toEqual(ASK)
  })

  it('still CLEARS a run-scoped denial on session_init (new run supersedes it)', () => {
    // The clear exists for a reason: a previous run's tool denial is residue
    // once new work starts. Only user-facing cards are exempt.
    const { state, slice } = buildHarness({
      status: 'connecting',
      activeRequestId: 'req-1',
      permissionDenied: RUN_DENIAL,
    })

    slice.handleNormalizedEvent!('tab1', sessionInit())

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toBeNull()
  })
})

describe('plan card survival — heartbeat reconciliation', () => {
  it('RESTORES a lost card from the engine-retained denials on an idle heartbeat', () => {
    // Recovery path. The engine retains unresolved denials and re-publishes
    // them on every idle heartbeat; the main-process pass-through surfaces a
    // given proposal only once, so if anything nulls the card after that first
    // delivery it previously stayed lost forever (observed: 20+ minutes of
    // "skipping proposal idle, already surfaced" with no card on screen).
    const { state, slice } = buildHarness({ status: 'completed', permissionDenied: null })

    slice.handleNormalizedEvent!('tab1', idleStatus(PLAN_DENIAL.tools))

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toEqual(PLAN_DENIAL)
  })

  it('does NOT overwrite a card already held (live entry has richer toolInput)', () => {
    const HELD = {
      tools: [{ toolName: 'ExitPlanMode', toolUseId: 'live', toolInput: { planFilePath: '/live.md' } }],
    }
    const { state, slice } = buildHarness({ status: 'completed', permissionDenied: HELD })

    slice.handleNormalizedEvent!('tab1', idleStatus(PLAN_DENIAL.tools))

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied).toEqual(HELD)
  })

  it('does NOT invent a card when the engine reports no retained denials', () => {
    // The engine clears its retention when a new prompt supersedes the
    // question, which is what makes a user dismissal stick.
    const { state, slice } = buildHarness({ status: 'completed', permissionDenied: null })

    slice.handleNormalizedEvent!('tab1', idleStatus(undefined))

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied ?? null).toBeNull()
  })

  it('does NOT restore a card from run-scoped retained denials', () => {
    const { state, slice } = buildHarness({ status: 'completed', permissionDenied: null })

    slice.handleNormalizedEvent!('tab1', idleStatus(RUN_DENIAL.tools))

    expect(mainInstance(state.conversationPanes, 'tab1')?.permissionDenied ?? null).toBeNull()
  })
})
