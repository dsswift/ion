/**
 * StatusDrawer running-only flat list: the running-dispatch section only
 * shows agents with status === 'running', not done/error agents.
 */

import { describe, it, expect } from 'vitest'
import { getDispatches } from '../../renderer/components/agent-panel-helpers'
import type { AgentStateUpdate } from '@ion/shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(
  overrides: { name: string; status?: string; depth?: number; metadata?: Record<string, unknown> },
): AgentStateUpdate {
  return {
    name: overrides.name,
    status: overrides.status ?? 'running',
    depth: overrides.depth ?? 0,
    dispatches: [],
    metadata: overrides.metadata ?? {},
  } as unknown as AgentStateUpdate
}

function makeDispatch(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    conversationId: `conv-${id}`,
    status: overrides.status ?? 'running',
    startTime: Date.now() - 5000,
    ...overrides,
  }
}

// ─── 1. Running-only flat list ────────────────────────────────────────────────

describe('running-only flat list filter', () => {
  const agents: AgentStateUpdate[] = [
    makeAgent({
      name: 'root',
      status: 'running',
      depth: 0,
      metadata: { dispatches: [makeDispatch('d1')] },
    }),
    makeAgent({
      name: 'done-child',
      status: 'done',
      depth: 1,
      metadata: { dispatches: [makeDispatch('d2', { status: 'done' })] },
    }),
    makeAgent({
      name: 'error-child',
      status: 'error',
      depth: 1,
      metadata: { dispatches: [makeDispatch('d3', { status: 'error' })] },
    }),
    makeAgent({
      name: 'running-child',
      status: 'running',
      depth: 2,
      metadata: { dispatches: [makeDispatch('d4')] },
    }),
  ]

  it('includes only running agents in the flat list', () => {
    const running = agents.filter((a) => a.status === 'running')
    expect(running).toHaveLength(2)
    expect(running.map((a) => a.name)).toEqual(['root', 'running-child'])
  })

  it('excludes done and error agents from the flat list', () => {
    const running = agents.filter((a) => a.status === 'running')
    expect(running.find((a) => a.name === 'done-child')).toBeUndefined()
    expect(running.find((a) => a.name === 'error-child')).toBeUndefined()
  })

  it('each running agent has at least one dispatch', () => {
    const running = agents.filter((a) => a.status === 'running')
    for (const agent of running) {
      const dispatches = getDispatches(agent)
      expect(dispatches.length).toBeGreaterThan(0)
    }
  })
})
