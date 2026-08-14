import { describe, it, expect } from 'vitest'

import {
  degradeOversizedEvent,
  canDegrade,
  DEGRADERS,
} from '../transport-degrade'
import { CRITICAL_TYPES, MAX_PLAINTEXT_BYTES } from '../transport-send'
import type { RemoteEvent } from '../protocol'

function agentStateEvent(metadataBytes: number, agentCount = 11): RemoteEvent {
  const bulk = 'x'.repeat(metadataBytes)
  return {
    type: 'desktop_agent_state',
    tabId: 'tab-1',
    instanceId: null,
    agents: Array.from({ length: agentCount }, (_, i) => ({
      name: `agent-${i}`,
      status: i === 0 ? 'running' : 'done',
      id: `d-${i}`,
      metadata: {
        displayName: `Agent ${i}`,
        type: 'specialist',
        visibility: 'always',
        invited: true,
        color: '#fff',
        dispatchId: `d-${i}`,
        dispatchParentId: '',
        dispatchDepth: 1,
        lastWork: bulk,
        task: bulk,
      },
    })),
  } as unknown as RemoteEvent
}

function agentStateWithDispatches(
  metadataBytes: number,
  dispatchCount: number,
  agentCount = 3,
): RemoteEvent {
  const bulk = 'x'.repeat(metadataBytes)
  return {
    type: 'desktop_agent_state',
    tabId: 'tab-1',
    instanceId: null,
    agents: Array.from({ length: agentCount }, (_, i) => ({
      name: `agent-${i}`,
      status: i === 0 ? 'running' : 'done',
      id: `d-${i}`,
      metadata: {
        displayName: `Agent ${i}`,
        type: 'specialist',
        visibility: 'always',
        invited: true,
        color: '#fff',
        dispatchId: `d-${i}`,
        dispatchParentId: '',
        dispatchDepth: 1,
        lastWork: bulk,
        task: bulk,
        dispatches: Array.from({ length: dispatchCount }, (_, j) => ({
          id: `dispatch-${i}-${j}`,
          task: bulk,
          model: 'claude-sonnet-4-6',
          conversationId: `conv-${i}-${j}`,
          status: j === 0 ? 'running' : 'done',
          startTime: 1700000000 + j,
        })),
      },
    })),
  } as unknown as RemoteEvent
}

describe('degradeOversizedEvent', () => {
  // The production shape: 11 agents at ~3.3 MB each, 35 MB total, over the
  // 6 MiB cap on all 1,873 attempts.
  it('sheds metadata from an oversized desktop_agent_state instead of giving up', () => {
    const event = agentStateEvent(3 * 1024 * 1024)
    const original = JSON.stringify(event).length
    expect(original).toBeGreaterThan(MAX_PLAINTEXT_BYTES)

    const result = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)

    expect(result).not.toBeNull()
    expect(result!.plaintext.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES)

    const degraded = result!.event as any
    expect(degraded.agents).toHaveLength(11)
    expect(degraded.metadataOmitted).toBe(true)
  })

  it('preserves every agent identity through degradation', () => {
    const event = agentStateEvent(3 * 1024 * 1024)
    const degraded = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)!.event as any

    for (let i = 0; i < 11; i++) {
      expect(degraded.agents[i].name).toBe(`agent-${i}`)
      expect(degraded.agents[i].id).toBe(`d-${i}`)
      expect(degraded.agents[i].status).toBe(i === 0 ? 'running' : 'done')
    }
  })

  // visibility and invited are not cosmetic. iOS defaults an absent visibility
  // to "ephemeral" and renders ephemeral agents only while running; an absent
  // invited defaults to false, hiding sticky rows. Shedding either would turn
  // a degraded payload into a silently empty agents panel — a wrong render
  // that looks successful, which is worse than the drop it replaces.
  it('keeps the metadata keys that decide whether a row renders at all', () => {
    const event = agentStateEvent(3 * 1024 * 1024)
    const degraded = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)!.event as any

    for (const a of degraded.agents) {
      expect(a.metadata.displayName).toBeTruthy()
      expect(a.metadata.visibility).toBe('always')
      expect(a.metadata.invited).toBe(true)
      expect(a.metadata.type).toBe('specialist')
      expect(a.metadata.dispatchId).toBeTruthy()
    }
  })

  it('drops the unbounded fields that caused the overflow', () => {
    const event = agentStateEvent(3 * 1024 * 1024)
    const degraded = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)!.event as any

    for (const a of degraded.agents) {
      expect(a.metadata.lastWork).toBeUndefined()
      expect(a.metadata.task).toBeUndefined()
    }
  })

  it('returns null when the degraded form still exceeds the cap', () => {
    // 200k agents: identity alone overflows, so shedding metadata is not enough.
    const event = agentStateEvent(10, 200_000)
    expect(degradeOversizedEvent(event, 1024)).toBeNull()
  })

  it('returns null for an event type with no degrader', () => {
    const event = { type: 'desktop_text_delta', tabId: 't', text: 'x' } as unknown as RemoteEvent
    expect(degradeOversizedEvent(event, 10)).toBeNull()
    expect(canDegrade('desktop_text_delta')).toBe(false)
  })

  it('does not mutate the original event', () => {
    const event = agentStateEvent(3 * 1024 * 1024)
    const before = (event as any).agents[0].metadata.lastWork.length

    degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)

    expect((event as any).agents[0].metadata.lastWork.length).toBe(before)
    expect((event as any).metadataOmitted).toBeUndefined()
  })
})

describe('two-stage degradation with dispatches', () => {
  it('stage 1 preserves slim dispatches when the result fits under the cap', () => {
    const event = agentStateWithDispatches(1_000_000, 5)
    const original = JSON.stringify(event).length
    expect(original).toBeGreaterThan(MAX_PLAINTEXT_BYTES)

    const result = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)

    expect(result).not.toBeNull()
    const degraded = result!.event as any
    expect(degraded.metadataOmitted).toBe(true)

    for (const a of degraded.agents) {
      expect(a.metadata.dispatches).toBeDefined()
      expect(a.metadata.dispatches).toHaveLength(5)

      for (const d of a.metadata.dispatches) {
        expect(d.id).toBeTruthy()
        expect(d.status).toBeTruthy()
        expect(d.conversationId).toBeTruthy()
        expect(d.startTime).toEqual(expect.any(Number))
        expect(d.task).toBeUndefined()
        expect(d.model).toBeUndefined()
        expect(d.elapsed).toBeUndefined()
      }
    }
  })

  it('stage 2 strips dispatches entirely when stage 1 still exceeds cap', () => {
    const event = agentStateWithDispatches(10, 200_000, 1)
    const original = JSON.stringify(event).length
    expect(original).toBeGreaterThan(MAX_PLAINTEXT_BYTES)

    const result = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)

    expect(result).not.toBeNull()
    const degraded = result!.event as any
    expect(degraded.metadataOmitted).toBe(true)

    for (const a of degraded.agents) {
      expect(a.metadata.dispatches).toBeUndefined()
      expect(a.metadata.displayName).toBeTruthy()
      expect(a.metadata.type).toBe('specialist')
    }
  })

  it('stamps metadataOmitted on both stages', () => {
    const smallDispatches = agentStateWithDispatches(1_000_000, 2)
    const result1 = degradeOversizedEvent(smallDispatches, MAX_PLAINTEXT_BYTES)
    expect((result1!.event as any).metadataOmitted).toBe(true)

    const hugeIdentity = agentStateEvent(3 * 1024 * 1024)
    const result2 = degradeOversizedEvent(hugeIdentity, MAX_PLAINTEXT_BYTES)
    expect((result2!.event as any).metadataOmitted).toBe(true)
  })

  it('preserves protected keys alongside slim dispatches in stage 1', () => {
    const event = agentStateWithDispatches(1_000_000, 3)
    const result = degradeOversizedEvent(event, MAX_PLAINTEXT_BYTES)!
    const degraded = result.event as any

    for (const a of degraded.agents) {
      expect(a.metadata.displayName).toBeTruthy()
      expect(a.metadata.visibility).toBe('always')
      expect(a.metadata.invited).toBe(true)
      expect(a.metadata.type).toBe('specialist')
      expect(a.metadata.dispatchId).toBeTruthy()
      expect(a.metadata.lastWork).toBeUndefined()
      expect(a.metadata.task).toBeUndefined()
    }
  })
})

describe('CRITICAL_TYPES contract', () => {
  // A critical type with no degrader can still only be dropped when oversized.
  // This guard makes that a deliberate, reviewed choice rather than an
  // oversight discovered in production 15 hours later.
  const WAIVED = new Set([
    // Small by construction — a control frame, not a payload.
    'desktop_heartbeat',
    'desktop_tab_created',
    'desktop_tab_closed',
    'desktop_user_turn_persisted',
    'desktop_stream_reset',
    'desktop_status',
    'desktop_message_end',
    'desktop_engine_error',
    'desktop_permission_request',
    'desktop_text_delta',
    'desktop_tool_start',
    'desktop_tool_end',
    // Large but already bounded/paginated at their source.
    'desktop_snapshot',
    'desktop_conversation_history',
    'desktop_terminal_snapshot',
  ])

  it('every critical type either has a degrader or an explicit waiver', () => {
    const unaccounted = [...CRITICAL_TYPES].filter(
      (t) => !DEGRADERS.has(t) && !WAIVED.has(t),
    )
    expect(
      unaccounted,
      `Critical types with neither a degrader nor a waiver: ${unaccounted.join(', ')}. ` +
        'Add a degrader in transport-degrade.ts, or waive it here with a reason.',
    ).toEqual([])
  })

  it('desktop_agent_state is degradable, since it is the one that overflowed', () => {
    expect(CRITICAL_TYPES.has('desktop_agent_state')).toBe(true)
    expect(canDegrade('desktop_agent_state')).toBe(true)
  })
})
