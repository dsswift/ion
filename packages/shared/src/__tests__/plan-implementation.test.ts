import { describe, expect, it } from 'vitest'
import type { Message } from '../types-session'
import { materializePlanImplementationDividers } from '../plan-implementation'

function message(value: Partial<Message> & Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>): Message {
  return value as Message
}

describe('materializePlanImplementationDividers', () => {
  it('adds the missing implementation divider from the durable user turn', () => {
    const messages = [
      message({
        id: 'plan-created',
        role: 'system',
        content: '── Plan created at 1:00 PM · olive-surfing-muffin ──',
        timestamp: 1000,
        planFilePath: '/plans/olive-surfing-muffin.md',
      }),
      message({
        id: 'implementation',
        role: 'user',
        content: 'Implement the following plan:\n\n# Plan',
        timestamp: new Date('2026-08-25T13:13:13.495Z').getTime(),
        implementationPhase: true,
      }),
    ]

    const result = materializePlanImplementationDividers(messages)

    expect(result).toHaveLength(3)
    expect(result[1]).toMatchObject({
      id: 'implementation:implementation-divider',
      role: 'system',
      planFilePath: '/plans/olive-surfing-muffin.md',
      timestamp: new Date('2026-08-25T13:13:13.495Z').getTime(),
    })
    expect(result[1]?.content).toContain('Implementing plan at ')
    expect(result[1]?.content).toContain('olive-surfing-muffin')
    expect(result[2]).toBe(messages[1])
  })

  it('uses the latest plan marker by timestamp when merged history rows are out of order', () => {
    const messages = [
      message({
        id: 'implementation',
        role: 'user',
        content: 'Implement the plan.',
        timestamp: 3000,
        implementationPhase: true,
      }),
      message({
        id: 'renderer-divider',
        role: 'system',
        content: '── Plan created at 1:00 PM · stale ──',
        timestamp: 1000,
        planFilePath: '/plans/stale.md',
      }),
      message({
        id: 'engine-plan',
        role: 'system',
        content: '── Plan created at 2:00 PM · current ──',
        timestamp: 2000,
        planFilePath: '/plans/current.md',
      }),
    ]

    const result = materializePlanImplementationDividers(messages)
    expect(result[0]?.content).toContain('current')
    expect(result[0]?.planFilePath).toBe('/plans/current.md')
  })

  it('keeps one existing live divider before its implementation turn', () => {
    const divider = message({
      id: 'divider',
      role: 'system',
      content: '── Implementing plan at 1:02 PM · plan ──',
      timestamp: 2000,
      planFilePath: '/plans/plan.md',
    })
    const implementation = message({
      id: 'implementation',
      role: 'user',
      content: 'Implement the plan.',
      timestamp: 2001,
      implementationPhase: true,
    })

    expect(materializePlanImplementationDividers([divider, implementation])).toEqual([
      divider,
      implementation,
    ])
  })

  it('does not invent a divider for an ordinary user turn', () => {
    const ordinary = message({ id: 'user', role: 'user', content: 'hello', timestamp: 3000 })
    expect(materializePlanImplementationDividers([ordinary])).toEqual([ordinary])
  })
})
