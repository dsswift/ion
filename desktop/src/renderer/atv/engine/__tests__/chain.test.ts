import { describe, it, expect } from 'vitest'
import { dispatchChainOf } from '../chain'
import type { AgentStateUpdate } from '../../../../shared/types'

function agent(name: string, metadata: Record<string, unknown> = {}): AgentStateUpdate {
  return { name, status: 'running', metadata } as unknown as AgentStateUpdate
}

describe('dispatchChainOf', () => {
  const agents = [
    agent('chief', { dispatches: [{ id: 'd1', task: '', model: '', conversationId: '', status: 'running' }] }),
    agent('lead', {
      dispatchParentId: 'd1',
      dispatches: [
        { id: 'd2', task: '', model: '', conversationId: '', status: 'running' },
        { id: 'd3', task: '', model: '', conversationId: '', status: 'done' },
      ],
    }),
    agent('dev-a', { dispatchParentId: 'd2' }),
    agent('dev-b', { dispatchParentId: 'd3' }),
    agent('outsider', { dispatchParentId: 'd-elsewhere' }),
  ]

  it('walks up to ancestors and down to all descendants over a 3-level tree', () => {
    const chain = dispatchChainOf(agents, 'lead')
    expect([...chain].sort()).toEqual(['chief', 'dev-a', 'dev-b', 'lead'])
  })

  it('from a leaf, includes the full lineage; outsiders excluded', () => {
    const chain = dispatchChainOf(agents, 'dev-a')
    expect(chain.has('chief')).toBe(true)
    expect(chain.has('lead')).toBe(true)
    expect(chain.has('outsider')).toBe(false)
  })

  it('unknown agent yields just itself', () => {
    expect([...dispatchChainOf(agents, 'ghost')]).toEqual(['ghost'])
  })
})
