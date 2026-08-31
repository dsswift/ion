/**
 * engine-slice-rewind — unit tests
 *
 * Tests rewindEngineInstance's target resolution AND its transactional
 * behavior in isolation over a hand-built set/get pair.
 *
 * Target resolution has two id "shapes" that matter, keyed on whether the
 * resolved row's id is a desktop-minted optimistic id (nextMsgId() → the
 * `msg-N` shape, mocked as `mock-msg-id`) or a durable engine-assigned entry
 * id (any other shape — a canonical hex id from history, or a row re-keyed by
 * `user_turn_persisted` / `steer_injected`):
 *   - A row with a DURABLE entry id → the action sends {entryId} to
 *     window.ion.engineRewind, exact-addressed.
 *   - A row with only an OPTIMISTIC id (found by id, or resolved via the
 *     user-turn-ordinal fallback for a not-yet-confirmed / iOS-forwarded
 *     target) → the action sends {userTurnIndex} instead.
 *
 * The ordinal fallback path is pinned against a message list with interleaved
 * tool/assistant rows to lock the invariant that user-turn ordinal is stable
 * regardless of interleaving.
 *
 * TRANSACTIONAL: window.ion.engineRewind is awaited BEFORE any local mutation.
 * A rejected result must leave conversationPanes and tabs completely
 * untouched — the historical bug was truncating local state synchronously
 * and only THEN checking the engine's result, so a rejected rewind silently
 * diverged the owner's transcript from the engine's tree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({})),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineRewindActions } from '../slices/engine-slice-rewind'
import type { State } from '../session-store-types'
import type { ConversationRef, ConversationPane, ConversationInstance } from '../../../shared/types-engine'
import { formatClearDivider } from '../../../shared/clear-divider'
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'

function makeTab(id: string) {
  return {
    id,
    title: 'Engine',
    engineProfileId: 'test-profile',
    workingDirectory: '/tmp',
    hasChosenDirectory: false,
    pillIcon: 'lightning',
    groupId: null,
    status: 'idle',
    customTitle: null,
    pillColor: null,
  }
}

function makeInstance(
  id: string,
  messages: Array<{ id: string; role: string; content: string; timestamp: number; toolName?: string }>,
): ConversationRef & ConversationInstance {
  return {
    id,
    label: 'Engine',
    messages: messages as any,
    messageCount: messages.length,
    modelOverride: null,
    modelOverrideSource: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: ['conv-prior'],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    dispatchTelemetry: [],
    contextBreakdown: null,
  }
}

function buildHarness(messages: Array<{ id: string; role: string; content: string; timestamp: number; toolName?: string }>) {
  const state: any = {
    tabs: [makeTab('tab1')],
    conversationPanes: new Map<string, ConversationPane>([
      ['tab1', { instances: [makeInstance('inst1', messages)], activeInstanceId: 'inst1' }],
    ]),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineRewindActions(set, get) as State
  return { state, slice }
}

// A representative engine instance message list: two user turns with
// interleaved assistant + tool rows, DURABLE ids throughout (as a
// history-loaded or re-keyed conversation would carry). User-turn ordinal 0 =
// first user msg; ordinal 1 = second user msg.
const INTERLEAVED_DURABLE = [
  { id: 'e-real-0', role: 'user', content: 'first prompt', timestamp: 1 },
  { id: 'a-1', role: 'assistant', content: 'thinking', timestamp: 2 },
  { id: 't-1', role: 'tool', content: 'ran tool', timestamp: 3, toolName: 'Bash' },
  { id: 'e-real-1', role: 'user', content: 'second prompt', timestamp: 4 },
  { id: 'a-2', role: 'assistant', content: 'replying', timestamp: 5 },
  { id: 't-2', role: 'tool', content: 'ran another', timestamp: 6, toolName: 'Read' },
]

// The same shape, but the SECOND user turn is still an unconfirmed optimistic
// bubble (msg-N id) — e.g. a fresh send the engine has not yet drained/keyed.
const INTERLEAVED_OPTIMISTIC_TARGET = [
  { id: 'e-real-0', role: 'user', content: 'first prompt', timestamp: 1 },
  { id: 'a-1', role: 'assistant', content: 'thinking', timestamp: 2 },
  { id: 't-1', role: 'tool', content: 'ran tool', timestamp: 3, toolName: 'Bash' },
  { id: 'msg-42', role: 'user', content: 'second prompt', timestamp: 4 },
  { id: 'a-2', role: 'assistant', content: 'replying', timestamp: 5 },
  { id: 't-2', role: 'tool', content: 'ran another', timestamp: 6, toolName: 'Read' },
]

let broadcastSpy: ReturnType<typeof vi.fn>
let rewindSpy: ReturnType<typeof vi.fn>
let stopSpy: ReturnType<typeof vi.fn>
let startSpy: ReturnType<typeof vi.fn>
let reconcileSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  broadcastSpy = vi.fn(async () => {})
  rewindSpy = vi.fn(async () => ({ ok: true }))
  stopSpy = vi.fn(async () => {})
  startSpy = vi.fn(async () => ({ ok: true }))
  reconcileSpy = vi.fn()
  ;(globalThis as any).window = {
    ion: {
      engineStop: stopSpy,
      engineStart: startSpy,
      engineBroadcastHistory: broadcastSpy,
      engineRewind: rewindSpy,
      reconcileCharts: reconcileSpy,
    },
  }
})

describe('rewindEngineInstance — target resolution and addressing mode', () => {
  it('resolves by id and sends {entryId} when the row carries a durable engine entry id', async () => {
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    // Rewind to the second user message by its durable id.
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-real-1')
    expect(result.ok).toBe(true)
    expect(rewindSpy).toHaveBeenCalledWith('tab1', { entryId: 'e-real-1' })
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    // keepMsgs = index of e-real-1 (3) → first 3 messages retained.
    expect(inst.messages.map((m: any) => m.id)).toEqual(['e-real-0', 'a-1', 't-1'])
    expect(state.tabs[0].pendingInput).toBe('second prompt')
    expect(result.prefill).toEqual({ text: 'second prompt', attachments: [] })
  })

  it('rewinds a Plain tab transactionally through its MAIN_INSTANCE_ID', async () => {
    // Plain is a profile choice, not a different conversation topology. It
    // still has one active `main` instance and must take the same engine-first
    // rewind path as an extension-hosted tab — never the retired destructive
    // resetTabSession rewind.
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    state.tabs[0].engineProfileId = null
    state.tabs[0].conversationId = 'plain-conversation'
    state.conversationPanes = new Map([
      ['tab1', { instances: [makeInstance(MAIN_INSTANCE_ID, INTERLEAVED_DURABLE)], activeInstanceId: MAIN_INSTANCE_ID }],
    ])

    const result = await slice.rewindEngineInstance('tab1', MAIN_INSTANCE_ID, 'e-real-1')

    expect(result.ok).toBe(true)
    expect(rewindSpy).toHaveBeenCalledWith('tab1', { entryId: 'e-real-1' })
    expect(stopSpy).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()
    expect(state.tabs[0].conversationId).toBe('plain-conversation')
    expect(state.tabs[0].pendingInput).toBe('second prompt')
    expect(result.prefill).toEqual({ text: 'second prompt', attachments: [] })
  })

  it('resolves by id but falls back to {userTurnIndex} when the row carries only an optimistic id', async () => {
    const { state, slice } = buildHarness(INTERLEAVED_OPTIMISTIC_TARGET)
    // The target row IS found by id, but its id is the desktop's own
    // not-yet-confirmed optimistic bubble — never send that as entryId, the
    // engine would reject an id it never persisted.
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'msg-42')
    expect(result.ok).toBe(true)
    expect(rewindSpy).toHaveBeenCalledWith('tab1', { userTurnIndex: 1 })
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.messages.map((m: any) => m.id)).toEqual(['e-real-0', 'a-1', 't-1'])
    expect(result.prefill).toEqual({ text: 'second prompt', attachments: [] })
  })

  it('resolves by userTurnIndex when id is absent (iOS-initiated path), stable across interleaving', async () => {
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    // iOS sends an optimistic-UUID id that does not exist, plus userTurnIndex=1
    // (the second user turn). Must resolve to e-real-1 at index 3 despite the
    // interleaved assistant/tool rows, and address the engine EXACTLY since
    // the resolved row does carry a durable entry id.
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE', 1)
    expect(result.ok).toBe(true)
    expect(rewindSpy).toHaveBeenCalledWith('tab1', { entryId: 'e-real-1' })
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.messages.map((m: any) => m.id)).toEqual(['e-real-0', 'a-1', 't-1'])
    expect(state.tabs[0].pendingInput).toBe('second prompt')
    expect(result.prefill).toEqual({ text: 'second prompt', attachments: [] })
  })

  it('resolves userTurnIndex=0 to the first user message', async () => {
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE', 0)
    expect(result.ok).toBe(true)
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.messages).toEqual([]) // nothing kept before the first user turn
    expect(state.tabs[0].pendingInput).toBe('first prompt')
    expect(result.prefill).toEqual({ text: 'first prompt', attachments: [] })
  })

  it('refuses when id is absent and userTurnIndex is out of range — no engine call, no mutation', async () => {
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    const before = state.conversationPanes.get('tab1')!.instances[0].messages.length
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE', 99)
    expect(result.ok).toBe(false)
    expect(rewindSpy).not.toHaveBeenCalled()
    expect(state.conversationPanes.get('tab1')!.instances[0].messages.length).toBe(before)
  })

  it('refuses when id is absent and no userTurnIndex is supplied — no engine call, no mutation', async () => {
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    const before = state.conversationPanes.get('tab1')!.instances[0].messages.length
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'UUID-NOT-IN-STORE')
    expect(result.ok).toBe(false)
    expect(rewindSpy).not.toHaveBeenCalled()
    expect(state.conversationPanes.get('tab1')!.instances[0].messages.length).toBe(before)
  })
})

describe('rewindEngineInstance — transactional gate: engine call precedes every local mutation', () => {
  it('calls engineRewind with the exact entry id, not engineStop/engineStart', async () => {
    const { slice } = buildHarness(INTERLEAVED_DURABLE)
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-real-1')
    expect(result.ok).toBe(true)
    expect(rewindSpy).toHaveBeenCalledWith('tab1', { entryId: 'e-real-1' })
    // The stop/start hack must be gone — it rebound to the same conversation
    // and duplicated the turn.
    expect(stopSpy).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('broadcasts the truncated history after the engine branch succeeds', async () => {
    const { slice } = buildHarness(INTERLEAVED_DURABLE)
    await slice.rewindEngineInstance('tab1', 'inst1', 'e-real-1')
    expect(broadcastSpy).toHaveBeenCalledWith('tab1', 'inst1')
  })

  it('does NOT truncate local state, does NOT broadcast, and returns ok:false when the engine rewind fails', async () => {
    rewindSpy.mockResolvedValueOnce({ ok: false, error: 'entry is not a user turn on the current path' })
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    const before = state.conversationPanes.get('tab1')!.instances[0].messages.length
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-real-1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('entry is not a user turn on the current path')
    expect(broadcastSpy).not.toHaveBeenCalled()
    // The instance's messages must be UNTOUCHED — no partial truncation on a
    // rejected engine branch. This is the exact regression the transactional
    // rewrite closes: the prior implementation truncated synchronously and
    // only THEN checked window.ion.engineRewind's resolved value.
    expect(state.conversationPanes.get('tab1')!.instances[0].messages.length).toBe(before)
    expect(state.tabs[0].pendingInput).toBeUndefined()
    expect(result.prefill).toBeUndefined()
  })

  it('returns ok:false and mutates nothing when the engine call itself rejects', async () => {
    rewindSpy.mockRejectedValueOnce(new Error('socket closed'))
    const { state, slice } = buildHarness(INTERLEAVED_DURABLE)
    const before = state.conversationPanes.get('tab1')!.instances[0].messages.length
    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-real-1')
    expect(result.ok).toBe(false)
    expect(result.prefill).toBeUndefined()
    expect(broadcastSpy).not.toHaveBeenCalled()
    expect(state.conversationPanes.get('tab1')!.instances[0].messages.length).toBe(before)
  })
})

describe('rewindEngineInstance — pending-card restoration after rewind', () => {
  // History whose kept slice (everything before the rewind target) ends with a
  // pending AskUserQuestion → the card must be restored on the rewound instance.
  const ASK_THEN_TARGET = [
    { id: 'e-0', role: 'user', content: 'do a thing', timestamp: 1 },
    { id: 'a-1', role: 'assistant', content: 'thinking', timestamp: 2 },
    { id: 'q-1', role: 'assistant', content: '', timestamp: 3, toolName: 'AskUserQuestion', toolId: 'tu-q', toolInput: '{"question":"which?"}' } as any,
    { id: 'e-1', role: 'user', content: 'rewind here', timestamp: 4 },
  ]

  it('restores the AskUserQuestion card when the kept history ends with it', async () => {
    const { state, slice } = buildHarness(ASK_THEN_TARGET)
    // Rewind to e-1 → keep [e-0, a-1, q-1]; that slice ends with the question.
    await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.permissionDenied).not.toBeNull()
    expect(inst.permissionDenied!.tools[0].toolName).toBe('AskUserQuestion')
  })

  // Same question, but a /clear divider sits between the question and the
  // rewind target → the kept slice ends with the clear, which dismisses the
  // card. Regression guard: a cleared question must NOT be resurrected.
  const ASK_THEN_CLEAR_THEN_TARGET = [
    { id: 'e-0', role: 'user', content: 'do a thing', timestamp: 1 },
    { id: 'q-1', role: 'assistant', content: '', timestamp: 2, toolName: 'AskUserQuestion', toolId: 'tu-q', toolInput: '{"question":"which?"}' } as any,
    { id: 'c-1', role: 'system', content: formatClearDivider(new Date()), timestamp: 3 },
    { id: 'e-1', role: 'user', content: 'rewind here', timestamp: 4 },
  ]

  it('does NOT restore the card when a /clear divider follows the question in the kept history', async () => {
    const { state, slice } = buildHarness(ASK_THEN_CLEAR_THEN_TARGET)
    // Rewind to e-1 → keep [e-0, q-1, c-1]; the clear divider dismisses it.
    await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.permissionDenied).toBeNull()
  })
})

describe('rewindEngineInstance — planFilePath restoration after rewind', () => {
  // History whose kept slice ends with a pending ExitPlanMode card whose
  // toolInput carries a planFilePath. After rewind the instance must have
  // planFilePath restored to that value so re-entering plan mode reuses the
  // same file instead of allocating a fresh slug.
  const EXIT_PLAN_PATH = '/home/user/.ion/plans/fancy-wishing-cookie.md'
  const EXIT_PLAN_THEN_TARGET = [
    { id: 'e-0', role: 'user', content: 'write a plan', timestamp: 1 },
    { id: 'a-1', role: 'assistant', content: 'planning...', timestamp: 2 },
    { id: 'e-1', role: 'assistant', content: '', timestamp: 3, toolName: 'ExitPlanMode', toolId: 'tu-e', toolInput: `{"planFilePath":"${EXIT_PLAN_PATH}"}` } as any,
    { id: 'e-2', role: 'user', content: 'implement it', timestamp: 4 },
  ]

  it('restores planFilePath from ExitPlanMode toolInput when the kept history ends with it', async () => {
    const { state, slice } = buildHarness(EXIT_PLAN_THEN_TARGET)
    // Rewind to e-2 → keep [e-0, a-1, e-1]; the kept slice ends with ExitPlanMode.
    await slice.rewindEngineInstance('tab1', 'inst1', 'e-2')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.planFilePath).toBe(EXIT_PLAN_PATH)
    // The ExitPlanMode card must also be restored.
    expect(inst.permissionDenied).not.toBeNull()
    expect(inst.permissionDenied!.tools[0].toolName).toBe('ExitPlanMode')
  })

  // When the pending card is NOT ExitPlanMode (e.g. AskUserQuestion),
  // planFilePath must remain null — the old behavior is preserved.
  const ASK_THEN_TARGET_FOR_PLAN = [
    { id: 'e-0', role: 'user', content: 'do a thing', timestamp: 1 },
    { id: 'q-1', role: 'assistant', content: '', timestamp: 2, toolName: 'AskUserQuestion', toolId: 'tu-q', toolInput: '{"question":"which approach?"}' } as any,
    { id: 'e-1', role: 'user', content: 'rewind here', timestamp: 3 },
  ]

  it('leaves planFilePath null when the pending card is AskUserQuestion (non-plan-mode rewind)', async () => {
    const { state, slice } = buildHarness(ASK_THEN_TARGET_FOR_PLAN)
    await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.planFilePath).toBeNull()
  })

  // When there is no pending card at all, planFilePath must also be null.
  const NO_CARD_THEN_TARGET = [
    { id: 'e-0', role: 'user', content: 'first turn', timestamp: 1 },
    { id: 'a-1', role: 'assistant', content: 'done', timestamp: 2 },
    { id: 'e-1', role: 'user', content: 'rewind here', timestamp: 3 },
  ]

  it('leaves planFilePath null when there is no pending card in the kept history', async () => {
    const { state, slice } = buildHarness(NO_CARD_THEN_TARGET)
    await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')
    const inst = state.conversationPanes.get('tab1')!.instances[0]
    expect(inst.planFilePath).toBeNull()
  })
})

/**
 * Chart-index reconciliation after a confirmed rewind.
 *
 * THE BUG THIS EXISTS FOR: the durable chart index is rebuildable from the
 * branch's tool rows, but nothing rebuilt it. A rewind past a chart revision
 * left the persisted record and the attachments row naming a revision the
 * branch had abandoned, while the transcript — derived live from the visible
 * messages — correctly showed the older card. The panel then offered a jump to
 * a revision the operator could not reach.
 *
 * These assertions fail with the reconcile call removed from the rewind's
 * success branch.
 */
describe('rewindEngineInstance — chart index reconciliation', () => {
  const CHART_RESULT_1 = 'Chart rendered in the conversation. id: tool-gate-1787864702164461001-1 · title: "Series" · line · 1 series · 2 points.'
  const CHART_RESULT_2 = 'Chart updated to revision 2. id: tool-gate-1787864702164461001-1 · title: "Series" · line · 1 series · 2 points.'
  const CHART_INPUT = '{"schemaVersion":1,"kind":"line","title":"Series","labels":["A","B"],"datasets":[{"label":"S","data":[1,2]}]}'

  // A create, then a later turn whose update the rewind will discard.
  const CHART_BRANCH = [
    { id: 'e-0', role: 'user', content: 'chart it', timestamp: 1 },
    { id: 'toolu_01', role: 'tool', content: CHART_RESULT_1, timestamp: 2, toolName: 'RenderChart', toolInput: CHART_INPUT, toolStatus: 'completed' } as any,
    { id: 'e-1', role: 'user', content: 'revise it', timestamp: 3 },
    { id: 'toolu_02', role: 'tool', content: CHART_RESULT_2, timestamp: 4, toolName: 'RenderChart', toolInput: CHART_INPUT, toolStatus: 'completed' } as any,
  ]

  it('reconciles with only the chart rows the rewound branch still contains', async () => {
    const { state, slice } = buildHarness(CHART_BRANCH)
    state.tabs[0].conversationId = 'conv-abc'

    await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')

    expect(reconcileSpy).toHaveBeenCalledTimes(1)
    const request = reconcileSpy.mock.calls[0][0] as {
      tabId: string; conversationId: string
      rows: Array<{ toolMessageId: string; resultText: string }>
    }
    expect(request.tabId).toBe('tab1')
    expect(request.conversationId).toBe('conv-abc')
    // The discarded revision's row must NOT travel: it is exactly the record
    // that would otherwise stay "current" on every surface.
    expect(request.rows.map((row) => row.toolMessageId)).toEqual(['toolu_01'])
    // Identity rides in the result text, never the row id.
    expect(request.rows[0].resultText).toBe(CHART_RESULT_1)
  })

  it('does NOT reconcile when the engine refuses the rewind', async () => {
    // A refused rewind leaves the engine tree untouched, so rebuilding the
    // index from a truncation that never happened would delete live records.
    rewindSpy.mockResolvedValueOnce({ ok: false, error: 'unknown entry' })
    const { state, slice } = buildHarness(CHART_BRANCH)
    state.tabs[0].conversationId = 'conv-abc'

    const result = await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')

    expect(result.ok).toBe(false)
    expect(reconcileSpy).not.toHaveBeenCalled()
  })

  it('skips reconciliation for a conversation with no durable id', async () => {
    // Nothing to scope a chart resource to yet; the fork path re-runs this
    // once the engine mints an id.
    const { state, slice } = buildHarness(CHART_BRANCH)
    state.tabs[0].conversationId = null

    await slice.rewindEngineInstance('tab1', 'inst1', 'e-1')

    expect(reconcileSpy).not.toHaveBeenCalled()
  })
})
