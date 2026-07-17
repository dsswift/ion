/**
 * Dispatch architecture fixture.
 *
 * Transcribed from the engine integration test fixture:
 *   engine/tests/integration/testdata/dispatch_architecture_events.json
 *
 * 2 sessions, 4 dispatches each (8 total). Round 1: alpha + beta fresh.
 * Round 2: alpha follow-up (continuation) + beta fresh.
 *
 * Values (dispatch ids, conv ids, models, elapsed, tasks) are taken
 * verbatim from the engine fixture so the three layers prove the same
 * reality.
 */
import type { AgentStateUpdate } from '../../../shared/types'
import type { DispatchInfo } from '../../../shared/types-engine'

// ── Engine fixture IDs (verbatim from engine JSON) ──

// sess-a round 1
const _A_R1_ALPHA_SESSION = 'sess-a-dispatch-alpha-1782668321080'
const _A_R1_BETA_SESSION  = 'sess-a-dispatch-beta-1782668321081'
// sess-a round 2
const _A_R2_ALPHA_SESSION = 'sess-a-dispatch-alpha-1782668321254'  // continuation of R1 alpha
const _A_R2_BETA_SESSION  = 'sess-a-dispatch-beta-1782668321260'

// sess-b round 1
const _B_R1_ALPHA_SESSION = 'sess-b-dispatch-alpha-1782668321081'
const _B_R1_BETA_SESSION  = 'sess-b-dispatch-beta-1782668321081'
// sess-b round 2
const _B_R2_ALPHA_SESSION = 'sess-b-dispatch-alpha-1782668321261'
const _B_R2_BETA_SESSION  = 'sess-b-dispatch-beta-1782668321265'

// Conversation IDs. Fresh dispatches get auto-generated conv IDs.
// The continuation (A_R2 alpha) reuses A_R1 alpha's conv ID.
const A_ALPHA_CONV = 'conv-a-alpha'
const A_R1_BETA_CONV = 'conv-a-beta-r1'
const A_R2_BETA_CONV = 'conv-a-beta-r2'

const B_ALPHA_R1_CONV = 'conv-b-alpha-r1'
const B_ALPHA_R2_CONV = 'conv-b-alpha-r2'
const B_BETA_R1_CONV = 'conv-b-beta-r1'
const B_BETA_R2_CONV = 'conv-b-beta-r2'

// Dispatch IDs (engine-assigned, collision-safe)
const A_R1_ALPHA_DID = 'dispatch-alpha-1782668321080-aaa111'
const A_R1_BETA_DID  = 'dispatch-beta-1782668321081-bbb222'
const A_R2_ALPHA_DID = 'dispatch-alpha-1782668321254-ccc333'
const A_R2_BETA_DID  = 'dispatch-beta-1782668321260-ddd444'

const B_R1_ALPHA_DID = 'dispatch-alpha-1782668321081-eee555'
const B_R1_BETA_DID  = 'dispatch-beta-1782668321081-fff666'
const B_R2_ALPHA_DID = 'dispatch-alpha-1782668321261-ggg777'
const B_R2_BETA_DID  = 'dispatch-beta-1782668321265-hhh888'

// ── Agent state snapshots (final state after all 4 dispatches per session) ──

function makeDispatches(entries: Array<{
  id: string; task: string; convId: string; elapsed: number; status: string; startTime: number
}>): DispatchInfo[] {
  return entries.map(e => ({
    id: e.id,
    task: e.task,
    model: 'mock-model',
    conversationId: e.convId,
    elapsed: e.elapsed,
    status: e.status,
    startTime: e.startTime,
  }))
}

// Elapsed values from the engine fixture (rounded to match fixture precision)
const ELAPSED = {
  a_r1_alpha: 0.166,
  a_r1_beta: 0.152,
  a_r2_alpha: 0.202,
  a_r2_beta: 0.183,
  b_r1_alpha: 0.166,
  b_r1_beta: 0.170,
  b_r2_alpha: 0.196,
  b_r2_beta: 0.196,
}

export const sessAAlphaDispatches: DispatchInfo[] = makeDispatches([
  { id: A_R1_ALPHA_DID, task: 'Task-AAA', convId: A_ALPHA_CONV, elapsed: ELAPSED.a_r1_alpha, status: 'done', startTime: 1782668321 },
  { id: A_R2_ALPHA_DID, task: 'Task-CCC', convId: A_ALPHA_CONV, elapsed: ELAPSED.a_r2_alpha, status: 'done', startTime: 1782668322 },
])

export const sessABetaDispatches: DispatchInfo[] = makeDispatches([
  { id: A_R1_BETA_DID, task: 'Task-BBB', convId: A_R1_BETA_CONV, elapsed: ELAPSED.a_r1_beta, status: 'done', startTime: 1782668321 },
  { id: A_R2_BETA_DID, task: 'Task-DDD', convId: A_R2_BETA_CONV, elapsed: ELAPSED.a_r2_beta, status: 'done', startTime: 1782668322 },
])

export const sessBAlphaDispatches: DispatchInfo[] = makeDispatches([
  { id: B_R1_ALPHA_DID, task: 'Task-EEE', convId: B_ALPHA_R1_CONV, elapsed: ELAPSED.b_r1_alpha, status: 'done', startTime: 1782668321 },
  { id: B_R2_ALPHA_DID, task: 'Task-GGG', convId: B_ALPHA_R2_CONV, elapsed: ELAPSED.b_r2_alpha, status: 'done', startTime: 1782668322 },
])

export const sessBBetaDispatches: DispatchInfo[] = makeDispatches([
  { id: B_R1_BETA_DID, task: 'Task-FFF', convId: B_BETA_R1_CONV, elapsed: ELAPSED.b_r1_beta, status: 'done', startTime: 1782668321 },
  { id: B_R2_BETA_DID, task: 'Task-HHH', convId: B_BETA_R2_CONV, elapsed: ELAPSED.b_r2_beta, status: 'done', startTime: 1782668322 },
])

/** Final agent state for sess-a (both agents done, 2 dispatches each). */
export const sessAAgentStates: AgentStateUpdate[] = [
  {
    name: 'alpha',
    status: 'done',
    metadata: {
      type: 'specialist',
      displayName: 'Alpha',
      visibility: 'sticky',
      invited: true,
      model: 'mock-model',
      elapsed: ELAPSED.a_r2_alpha,
      dispatches: sessAAlphaDispatches,
    },
  },
  {
    name: 'beta',
    status: 'done',
    metadata: {
      type: 'specialist',
      displayName: 'Beta',
      visibility: 'sticky',
      invited: true,
      model: 'mock-model',
      elapsed: ELAPSED.a_r2_beta,
      dispatches: sessABetaDispatches,
    },
  },
]

/** Final agent state for sess-b (both agents done, 2 dispatches each). */
export const sessBAgentStates: AgentStateUpdate[] = [
  {
    name: 'alpha',
    status: 'done',
    metadata: {
      type: 'specialist',
      displayName: 'Alpha',
      visibility: 'sticky',
      invited: true,
      model: 'mock-model',
      elapsed: ELAPSED.b_r2_alpha,
      dispatches: sessBAlphaDispatches,
    },
  },
  {
    name: 'beta',
    status: 'done',
    metadata: {
      type: 'specialist',
      displayName: 'Beta',
      visibility: 'sticky',
      invited: true,
      model: 'mock-model',
      elapsed: ELAPSED.b_r2_beta,
      dispatches: sessBBetaDispatches,
    },
  },
]

// ── Exported constants for cross-layer assertions ──

export const CONV_IDS = {
  A_ALPHA: A_ALPHA_CONV,         // shared by R1 and R2 (continuation)
  A_R1_BETA: A_R1_BETA_CONV,
  A_R2_BETA: A_R2_BETA_CONV,
  B_R1_ALPHA: B_ALPHA_R1_CONV,
  B_R2_ALPHA: B_ALPHA_R2_CONV,
  B_R1_BETA: B_BETA_R1_CONV,
  B_R2_BETA: B_BETA_R2_CONV,
}

export const DISPATCH_IDS = {
  A_R1_ALPHA: A_R1_ALPHA_DID,
  A_R1_BETA: A_R1_BETA_DID,
  A_R2_ALPHA: A_R2_ALPHA_DID,
  A_R2_BETA: A_R2_BETA_DID,
  B_R1_ALPHA: B_R1_ALPHA_DID,
  B_R1_BETA: B_R1_BETA_DID,
  B_R2_ALPHA: B_R2_ALPHA_DID,
  B_R2_BETA: B_R2_BETA_DID,
}
