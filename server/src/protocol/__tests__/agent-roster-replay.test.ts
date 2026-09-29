/**
 * A connection is handed every conversation's current agent roster when it
 * attaches. Clients build the agent panel from `agent_state` events alone and
 * the engine re-sends a roster only on its heartbeat, so a browser that
 * loaded after the last event showed an empty agent panel for up to that
 * interval.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../config/current', () => ({ isSharedTenancy: () => false, unownedTabsVisible: () => false }))
vi.mock('../../store/startup-progress', () => ({ startupReportForAttach: () => null }))
vi.mock('../tabs-index', () => ({ tabIdVisibleToSubject: (tabId: string, subject: string | null) => subject === 'owner' && tabId.startsWith('tab-') }))

import { attachConnectionToEvents } from '../events'
import { recordAgentState, clearAgentStateForTab } from '../../engine/agent-state-mirror'
import type { Connection } from '../connection'
import type { AgentStateUpdate } from '@ion/shared/types-engine'

function conn(subject: string, view: 'mirror' | 'thin' = 'mirror') {
  const sent: unknown[] = []
  const c = { id: subject, isClosed: false, view, scopes: [], principal: { subject }, thinDirectories: new Set<string>(), send: (frame: unknown) => { sent.push(frame) } } as unknown as Connection
  return { c, sent }
}

const agents = [{ name: 'briefing-writer', status: 'done' }] as unknown as AgentStateUpdate[]

describe('agent roster replay on attach', () => {
  it("sends the owner's current rosters under the key a live event carries", () => {
    recordAgentState('tab-1', null, agents)
    recordAgentState('tab-2', 'ext-1', agents)
    recordAgentState('tab-3', null, [])
    const owner = conn('owner')
    const detach = attachConnectionToEvents(owner.c)

    expect(owner.sent).toEqual([
      { type: 'studio_event', channel: 'ion:normalized-event', payload: ['tab-1', { type: 'agent_state', agents }] },
      { type: 'studio_event', channel: 'ion:normalized-event', payload: ['tab-2:ext-1', { type: 'agent_state', agents }] },
    ])
    detach()
    for (const t of ['tab-1', 'tab-2', 'tab-3']) clearAgentStateForTab(t)
  })

  it("sends nobody another person's rosters", () => {
    recordAgentState('tab-1', null, agents)
    const stranger = conn('stranger')
    const detach = attachConnectionToEvents(stranger.c)
    expect(stranger.sent).toEqual([])
    detach()
    clearAgentStateForTab('tab-1')
  })
})
