// agent-state-selfheal-giveup.test.ts — pins the self-heal give-up state
// machine.
//
// The retry half of self-heal once ran unbounded: a roster whose delivery had
// already failed (degraded/dropped as oversized) was re-sent every 2 seconds,
// re-failed identically, and re-scheduled itself — a livelock that survived
// engine restarts because the stale mirror entry was never invalidated. These
// tests fail on that code: the second identical send fired unconditionally.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
}))

const { state } = vi.hoisted(() => ({
  state: { remoteTransport: null } as {
    remoteTransport: {
      sendToDevice: (deviceId: string, event: unknown) => void
      send: (event: unknown) => void
    } | null
  },
}))
vi.mock('../../../state', () => ({ state }))

import {
  scheduleAgentStateSelfHeal,
  noteAgentStateDeliveryFailure,
  resetAgentStateSelfHeal,
} from '../agent-state'
import { recordAgentState, clearAllAgentState } from '../../../agent-state-mirror'

const sent: any[] = []

function roster(task: string) {
  return [{ name: 'a', status: 'running', metadata: { displayName: 'A', task } }] as never
}

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  clearAllAgentState()
  resetAgentStateSelfHeal()
  state.remoteTransport = {
    sendToDevice: () => {},
    send: (event) => { sent.push(event) },
  }
})

describe('agent-state self-heal give-up', () => {
  it('re-sends when the roster differs from the one that failed', () => {
    recordAgentState('tab-1', null, roster('new work'))
    noteAgentStateDeliveryFailure('tab-1', roster('old failed payload'))

    scheduleAgentStateSelfHeal('tab-1', null)
    vi.advanceTimersByTime(2100)

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('desktop_agent_state')
  })

  it('suppresses the re-send when the payload is identical to the failed one', () => {
    const failed = roster('same payload')
    recordAgentState('tab-1', null, failed)
    noteAgentStateDeliveryFailure('tab-1', failed)

    scheduleAgentStateSelfHeal('tab-1', null)
    vi.advanceTimersByTime(2100)

    expect(sent).toHaveLength(0)
  })

  it('does not livelock: a suppressed heal schedules nothing further', () => {
    const failed = roster('same payload')
    recordAgentState('tab-1', null, failed)
    noteAgentStateDeliveryFailure('tab-1', failed)

    scheduleAgentStateSelfHeal('tab-1', null)
    vi.advanceTimersByTime(60_000)

    expect(sent).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-arms when a new roster arrives after a suppression', () => {
    const failed = roster('same payload')
    recordAgentState('tab-1', null, failed)
    noteAgentStateDeliveryFailure('tab-1', failed)
    scheduleAgentStateSelfHeal('tab-1', null)
    vi.advanceTimersByTime(2100)
    expect(sent).toHaveLength(0)

    // The engine emits a genuinely different roster.
    recordAgentState('tab-1', null, roster('fresh roster'))
    scheduleAgentStateSelfHeal('tab-1', null)
    vi.advanceTimersByTime(2100)

    expect(sent).toHaveLength(1)
  })

  it('re-arms on reset (engine reconnect voids the failure record)', () => {
    const failed = roster('same payload')
    recordAgentState('tab-1', null, failed)
    noteAgentStateDeliveryFailure('tab-1', failed)

    resetAgentStateSelfHeal()

    scheduleAgentStateSelfHeal('tab-1', null)
    vi.advanceTimersByTime(2100)

    expect(sent).toHaveLength(1)
  })

  it('scopes the failure record per tab', () => {
    const failed = roster('same payload')
    recordAgentState('tab-1', null, failed)
    recordAgentState('tab-2', null, failed)
    noteAgentStateDeliveryFailure('tab-1', failed)

    scheduleAgentStateSelfHeal('tab-1', null)
    scheduleAgentStateSelfHeal('tab-2', null)
    vi.advanceTimersByTime(2100)

    expect(sent).toHaveLength(1)
    expect(sent[0].tabId).toBe('tab-2')
  })
})
