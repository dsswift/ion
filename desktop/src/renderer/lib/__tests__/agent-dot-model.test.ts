// Behavioral pins for the agent row's two-dot status model.
//
// THE BUG THIS EXISTS FOR: a lead agent whose most recent dispatch finished
// while an OLDER dispatch still owned a running specialist rendered as a single
// solid green dot, and the panel header read "3 done" with no active segment.
// The live specialist — which may have stalled — was invisible.
//
// The model splits the row's indicator in two so that state is legible:
//   foreground = the most recent dispatch, always
//   background = the aggregate of the earlier dispatches, never the most recent
//
// Excluding the most recent from the background is load-bearing. The two
// "reported case" / "inverse case" tests below are a PAIR: either one alone
// would still pass if the model folded every dispatch into one lumped dot, and
// only together do they pin that the two subjects stay distinct.
import { describe, it, expect } from 'vitest'
import { resolveAgentDotModel } from '../agent-dot-model'
import type { AgentStateUpdate } from '../../../shared/types'
import type { StatusDotColors } from '../agent-helpers'

// Distinct sentinel per token so an assertion names the exact theme token.
const COLORS: StatusDotColors = {
  statusRunning: 'RUNNING',
  statusWaitingChildren: 'WAITING',
  statusWaitingChildrenGlow: 'WAITING_GLOW',
  statusComplete: 'COMPLETE',
  statusError: 'ERROR',
  statusIdle: 'IDLE',
}

type Dispatch = { id: string; status?: string; startTime?: number }

/** An agent row carrying the given dispatches. */
function lead(status: string, dispatches: Dispatch[]): AgentStateUpdate {
  return {
    name: 'dev-lead',
    status,
    metadata: { displayName: 'Dev Lead', dispatches },
  } as unknown as AgentStateUpdate
}

/** A child agent parented to a specific dispatch id. */
function child(
  name: string,
  status: string,
  parentDispatchId: string,
  ownDispatches: Dispatch[] = [],
): AgentStateUpdate {
  return {
    name,
    status,
    metadata: {
      displayName: name,
      dispatchParentId: parentDispatchId,
      dispatchDepth: 2,
      dispatches: ownDispatches,
    },
  } as unknown as AgentStateUpdate
}

describe('resolveAgentDotModel — collapse rule', () => {
  it('an agent with no dispatches renders a single dot from its own status', () => {
    const roster = { name: 'solo', status: 'idle', metadata: {} } as AgentStateUpdate
    const model = resolveAgentDotModel(roster, [roster], COLORS)
    expect(model.kind).toBe('single')
    if (model.kind !== 'single') throw new Error('expected single')
    expect(model.dot.bg).toBe('IDLE')
  })

  it('a single dispatch renders one dot (no empty background layer)', () => {
    const agent = lead('running', [{ id: 'd1', status: 'running', startTime: 100 }])
    const model = resolveAgentDotModel(agent, [agent], COLORS)
    expect(model.kind).toBe('single')
  })

  it('two dispatches render the stack', () => {
    const agent = lead('done', [
      { id: 'd1', status: 'done', startTime: 100 },
      { id: 'd2', status: 'done', startTime: 200 },
    ])
    const model = resolveAgentDotModel(agent, [agent], COLORS)
    expect(model.kind).toBe('stack')
  })
})

describe('resolveAgentDotModel — most-recent vs. older split', () => {
  // THE REPORTED CASE. Most recent dispatch finished; an older one still owns a
  // running depth-2 descendant. Foreground green, background pulsing yellow.
  it('recent done + older dispatch with a live descendant → green over pulsing yellow', () => {
    const agent = lead('done', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'done', startTime: 200 },
    ])
    const spec = child('code-engineer', 'running', 'd-old')
    const model = resolveAgentDotModel(agent, [agent, spec], COLORS)

    expect(model.kind).toBe('stack')
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.foreground.bg).toBe('COMPLETE')
    expect(model.foreground.pulse).toBe(false)
    expect(model.background.bg).toBe('WAITING')
    expect(model.background.pulse).toBe(true)
    expect(model.background.glowColor).toBe('WAITING_GLOW')
  })

  // THE INVERSE. Most recent is actively running; history is clean. Pairs with
  // the test above: a lumped single-dot model cannot satisfy both.
  it('recent running + older all done → orange over green', () => {
    const agent = lead('running', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'running', startTime: 200 },
    ])
    const model = resolveAgentDotModel(agent, [agent], COLORS)

    expect(model.kind).toBe('stack')
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.foreground.bg).toBe('RUNNING')
    expect(model.foreground.pulse).toBe(true)
    expect(model.background.bg).toBe('COMPLETE')
    expect(model.background.pulse).toBe(false)
  })

  it('the background never reflects the most recent dispatch', () => {
    // Most recent errored; every earlier dispatch finished cleanly. If the
    // background folded in the most recent it would go red.
    const agent = lead('error', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'error', startTime: 200 },
    ])
    const model = resolveAgentDotModel(agent, [agent], COLORS)

    expect(model.kind).toBe('stack')
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.foreground.bg).toBe('ERROR')
    expect(model.background.bg).toBe('COMPLETE')
  })
})

describe('resolveAgentDotModel — most-recent resolution', () => {
  it('resolves by startTime, not array position', () => {
    // The engine merges dispatches in slot-insertion order and de-dupes by id,
    // so array order is only incidentally chronological. Here the CHRONO-recent
    // dispatch (d-late) sits first in the array.
    const agent = lead('done', [
      { id: 'd-late', status: 'running', startTime: 900 },
      { id: 'd-early', status: 'done', startTime: 100 },
    ])
    const model = resolveAgentDotModel(agent, [agent], COLORS)

    expect(model.kind).toBe('stack')
    if (model.kind !== 'stack') throw new Error('expected stack')
    // Foreground must follow d-late (running), not the last array slot.
    expect(model.foreground.bg).toBe('RUNNING')
    expect(model.background.bg).toBe('COMPLETE')
  })

  it('falls back to array position when no dispatch carries a startTime', () => {
    const agent = lead('done', [
      { id: 'd1', status: 'done' },
      { id: 'd2', status: 'running' },
    ])
    const model = resolveAgentDotModel(agent, [agent], COLORS)
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.foreground.bg).toBe('RUNNING')
  })
})

describe('resolveAgentDotModel — descendant walk', () => {
  it('counts a suspended descendant as live (a parked dispatch has not finished)', () => {
    const agent = lead('done', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'done', startTime: 200 },
    ])
    const parked = child('specialist', 'suspended', 'd-old')
    const model = resolveAgentDotModel(agent, [agent, parked], COLORS)
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.background.bg).toBe('WAITING')
  })

  it('detects a depth-3 descendant, not just direct children', () => {
    const agent = lead('done', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'done', startTime: 200 },
    ])
    // d-old → mid (done, owns d-mid) → deep (running). Only a recursive walk
    // reaches `deep`; matching direct children alone reports all-clear.
    const mid = child('mid-lead', 'done', 'd-old', [{ id: 'd-mid', status: 'done' }])
    const deep = child('deep-worker', 'running', 'd-mid')
    const model = resolveAgentDotModel(agent, [agent, mid, deep], COLORS)
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.background.bg).toBe('WAITING')
  })

  it('terminal descendants leave the background green', () => {
    const agent = lead('done', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'done', startTime: 200 },
    ])
    const finished = child('specialist', 'done', 'd-old')
    const model = resolveAgentDotModel(agent, [agent, finished], COLORS)
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.background.bg).toBe('COMPLETE')
  })

  it('terminates on a cycle in dispatchParentId', () => {
    const agent = lead('done', [
      { id: 'd-old', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'done', startTime: 200 },
    ])
    // a → b → a: malformed attribution must not spin forever.
    const a = child('a', 'done', 'd-old', [{ id: 'd-a', status: 'done' }])
    const b = child('b', 'done', 'd-a', [{ id: 'd-old', status: 'done' }])
    const model = resolveAgentDotModel(agent, [agent, a, b], COLORS)
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.background.bg).toBe('COMPLETE')
  })

  it('error outranks waiting in the background fold', () => {
    const agent = lead('done', [
      { id: 'd-err', status: 'error', startTime: 50 },
      { id: 'd-wait', status: 'done', startTime: 100 },
      { id: 'd-recent', status: 'done', startTime: 200 },
    ])
    const spec = child('specialist', 'running', 'd-wait')
    const model = resolveAgentDotModel(agent, [agent, spec], COLORS)
    if (model.kind !== 'stack') throw new Error('expected stack')
    expect(model.background.bg).toBe('ERROR')
  })
})
