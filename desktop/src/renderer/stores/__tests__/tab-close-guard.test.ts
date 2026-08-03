/**
 * Unit tests for the pure close-guard predicate extracted from tab-slice.ts.
 *
 * evaluateCloseGuard is TAB-TYPE-AGNOSTIC by construction: it reads only
 * per-instance statusFields.state + agentStates and has no notion of tab type.
 * These tests pin the fold arithmetic at the pure-function seam; the closeTab
 * action wiring (which uses this) is covered by tab-slice-close-guard.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { evaluateCloseGuard, formatCloseGuardRefusal, describeCloseGuardReason } from '../slices/tab-close-guard'

describe('evaluateCloseGuard', () => {
  it('does not block when pane is null/undefined (nothing to protect)', () => {
    expect(evaluateCloseGuard(null).blocked).toBe(false)
    expect(evaluateCloseGuard(undefined).blocked).toBe(false)
  })

  it('does not block when there are no instances', () => {
    expect(evaluateCloseGuard({ instances: [] }).blocked).toBe(false)
  })

  it('does not block a quiescent instance (idle, no running agents)', () => {
    const r = evaluateCloseGuard({ instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [] }] })
    expect(r.blocked).toBe(false)
    expect(r.orchestratorRunning).toBe(false)
  })

  it('blocks when the orchestrator is running / connecting / starting', () => {
    for (const state of ['running', 'connecting', 'starting']) {
      const r = evaluateCloseGuard({ instances: [{ id: 'main', statusFields: { state }, agentStates: [] }] })
      expect(r.blocked, state).toBe(true)
      expect(r.orchestratorRunning, state).toBe(true)
    }
  })

  it('blocks when a background child agent is running (orchestrator idle)', () => {
    const r = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [{ status: 'done' }, { status: 'running' }] }],
    })
    expect(r.blocked).toBe(true)
    expect(r.orchestratorRunning).toBe(false)
    expect(r.childCounts).toEqual([{ id: 'main', count: 1 }])
  })

  it('blocks when a sibling instance has a running child even if the active one is idle', () => {
    const r = evaluateCloseGuard({
      instances: [
        { id: 'inst1', statusFields: { state: 'idle' }, agentStates: [] },
        { id: 'inst2', statusFields: { state: 'idle' }, agentStates: [{ status: 'running' }] },
      ],
    })
    expect(r.blocked).toBe(true)
  })

  it('does not block when every agent is terminal', () => {
    const r = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [{ status: 'done' }, { status: 'error' }, { status: 'cancelled' }] }],
    })
    expect(r.blocked).toBe(false)
  })
})

describe('evaluateCloseGuard — background bash commands', () => {
  // Closing a tab runs the engine's StopBackgroundTasksForOwner, which kills
  // the session's running shell processes. A long build dying because a tab
  // was closed is the same footgun as a killed sub-agent, so outstanding
  // background commands block close exactly as running children do.
  //
  // This guard is the single authoritative one — the X button, middle-click,
  // Cmd+W, the dropdown row, and the group-pill close path all funnel through
  // closeTab, which calls it. Pinning it here covers every entry point.

  it('blocks when an instance is waiting on background commands', () => {
    const r = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle', backgroundShells: 2 }, agentStates: [] }],
    })
    expect(r.blocked).toBe(true)
    expect(r.shellCount).toBe(2)
    expect(r.orchestratorRunning).toBe(false)
  })

  it('sums outstanding commands across instances', () => {
    const r = evaluateCloseGuard({
      instances: [
        { id: 'inst1', statusFields: { state: 'idle', backgroundShells: 1 }, agentStates: [] },
        { id: 'inst2', statusFields: { state: 'idle', backgroundShells: 3 }, agentStates: [] },
      ],
    })
    expect(r.shellCount).toBe(4)
    expect(r.blocked).toBe(true)
  })

  it('does not block when no commands are outstanding', () => {
    const r = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle', backgroundShells: 0 }, agentStates: [] }],
    })
    expect(r.blocked).toBe(false)
    expect(r.shellCount).toBe(0)
  })

  it('does not block when the field is absent entirely (older engine)', () => {
    const r = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [] }],
    })
    expect(r.blocked).toBe(false)
    expect(r.shellCount).toBe(0)
  })

  it('blocks on shells even when agents and orchestrator are both quiet', () => {
    const r = evaluateCloseGuard({
      instances: [
        { id: 'main', statusFields: { state: 'idle', backgroundShells: 1 }, agentStates: [{ status: 'done' }] },
      ],
    })
    expect(r.blocked).toBe(true)
  })
})

describe('formatCloseGuardRefusal', () => {
  it('includes the tab id, orchestrator flag, and per-instance counts', () => {
    const r = evaluateCloseGuard({ instances: [{ id: 'main-abc', statusFields: { state: 'idle' }, agentStates: [{ status: 'running' }] }] })
    const msg = formatCloseGuardRefusal('tab1-deadbeef', r)
    expect(msg).toContain('refused tab close')
    expect(msg).toContain('orchestratorRunning=false')
    expect(msg).toContain('main-a:1')
    expect(msg).toContain('backgroundShells=0')
  })
})

/**
 * The OPERATOR-facing half of the same result. Quoted verbatim into the retire
 * refusal dialog, so this is what someone reads when Ion declines to delete a
 * worktree — it has to say something they can act on, and it must agree with the
 * guard that did the blocking.
 */
describe('describeCloseGuardReason', () => {
  it('says "running" for a busy orchestrator', () => {
    const r = evaluateCloseGuard({ instances: [{ id: 'main', statusFields: { state: 'running' }, agentStates: [] }] })
    expect(describeCloseGuardReason(r)).toBe('running')
  })

  it('counts dispatched background agents, pluralising correctly', () => {
    const one = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [{ status: 'running' }] }],
    })
    expect(describeCloseGuardReason(one)).toBe('1 background agent running')

    const many = evaluateCloseGuard({
      instances: [{
        id: 'main',
        statusFields: { state: 'idle' },
        agentStates: [{ status: 'running' }, { status: 'running' }, { status: 'done' }],
      }],
    })
    expect(describeCloseGuardReason(many)).toBe('2 background agents running')
  })

  it('counts outstanding background commands, pluralising correctly', () => {
    const one = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle', backgroundShells: 1 }, agentStates: [] }],
    })
    expect(describeCloseGuardReason(one)).toBe('1 background command running')

    const many = evaluateCloseGuard({
      instances: [{ id: 'main', statusFields: { state: 'idle', backgroundShells: 3 }, agentStates: [] }],
    })
    expect(describeCloseGuardReason(many)).toBe('3 background commands running')
  })

  it('sums agents across instances', () => {
    const r = evaluateCloseGuard({
      instances: [
        { id: 'a', statusFields: { state: 'idle' }, agentStates: [{ status: 'running' }] },
        { id: 'b', statusFields: { state: 'idle' }, agentStates: [{ status: 'running' }] },
      ],
    })
    expect(describeCloseGuardReason(r)).toBe('2 background agents running')
  })

  it('joins every blocking cause, so a refusal never understates the reason', () => {
    const r = evaluateCloseGuard({
      instances: [{
        id: 'main',
        statusFields: { state: 'running', backgroundShells: 2 },
        agentStates: [{ status: 'running' }],
      }],
    })
    expect(describeCloseGuardReason(r))
      .toBe('running, 1 background agent running, 2 background commands running')
  })

  // An idle tab is not blocked, so there is no reason to state. Inventing one
  // would put a false claim in front of the operator.
  it('is empty for an idle tab', () => {
    const r = evaluateCloseGuard({ instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [] }] })
    expect(describeCloseGuardReason(r)).toBe('')
  })
})
