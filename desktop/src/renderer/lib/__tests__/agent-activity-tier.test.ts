import { describe, expect, it } from 'vitest'
import { resolveAgentDotModel, resolveDispatchDot } from '../agent-dot-model'
import { activityTierForAgent, activityTierForDispatch, sortAgents, type StatusDotColors } from '../agent-helpers'
import type { AgentStateUpdate } from '../../../shared/types'
import type { DispatchInfo } from '../../../shared/types-engine'

const COLORS: StatusDotColors = {
  statusRunning: 'RUNNING',
  statusWaitingChildren: 'WAITING',
  statusWaitingChildrenGlow: 'WAITING_GLOW',
  statusBash: 'BASH',
  statusBashGlow: 'BASH_GLOW',
  statusComplete: 'COMPLETE',
  statusError: 'ERROR',
  statusIdle: 'IDLE',
}

function agent(name: string, dispatches: Partial<DispatchInfo>[]): AgentStateUpdate {
  return { name, status: 'done', metadata: { displayName: name, visibility: 'always', dispatches } } as AgentStateUpdate
}

describe('agent activity tiers', () => {
  it('maps durable dispatch metadata to running, child, shell, and terminal tiers', () => {
    expect(activityTierForDispatch({ id: 'run', status: 'running' } as DispatchInfo)).toBe('running')
    expect(activityTierForDispatch({ id: 'child', status: 'suspended', waitingOn: 'children' } as DispatchInfo)).toBe('children')
    expect(activityTierForDispatch({ id: 'shell', status: 'suspended', waitingOn: 'shell' } as DispatchInfo)).toBe('shell')
    expect(activityTierForDispatch({ id: 'done', status: 'done' } as DispatchInfo)).toBe('terminal')
  })

  it('orders newest dispatch first, then earlier dispatch activity, then never-dispatched roster rows', () => {
    const completed = agent('completed', [{ id: 'done', status: 'done', startTime: 10 }])
    const legacyWaiting = agent('legacy-waiting', [{ id: 'legacy-parent', status: 'done', startTime: 10 }])
    const legacyChild = {
      name: 'legacy-specialist',
      status: 'running',
      metadata: { dispatchParentId: 'legacy-parent' },
    } as AgentStateUpdate
    const historicalShell = agent('historical-shell', [
      { id: 'shell', status: 'suspended', waitingOn: 'shell', startTime: 1 },
      { id: 'recent-done', status: 'done', startTime: 10 },
    ])
    const child = agent('child', [{ id: 'child', status: 'suspended', waitingOn: 'children', startTime: 10 }])
    const shell = agent('shell', [{ id: 'shell', status: 'suspended', waitingOn: 'shell', startTime: 10 }])
    const running = agent('running', [{ id: 'run', status: 'running', startTime: 10 }])
    const neverDispatched = { name: 'roster', status: 'idle', metadata: { displayName: 'roster', visibility: 'always' } } as AgentStateUpdate

    expect(sortAgents(
      [neverDispatched, completed, legacyWaiting, historicalShell, shell, child, running],
      [neverDispatched, completed, legacyWaiting, legacyChild, historicalShell, shell, child, running],
    ).map((row) => row.name)).toEqual([
      'running', 'child', 'legacy-waiting', 'shell', 'historical-shell', 'completed', 'roster',
    ])
    expect(activityTierForAgent(legacyWaiting, [legacyWaiting, legacyChild])).toEqual({ foreground: 1, background: 3 })
    expect(activityTierForAgent(historicalShell)).toEqual({ foreground: 3, background: 2 })
  })

  it('uses running, child, and shell dot tiers while preserving newest-versus-history split', () => {
    const model = resolveAgentDotModel(agent('lead', [
      { id: 'old', status: 'suspended', waitingOn: 'shell', startTime: 1 },
      { id: 'current', status: 'running', startTime: 2 },
    ]), COLORS)
    expect(model).toMatchObject({
      kind: 'stack',
      foreground: { bg: 'RUNNING', pulse: true },
      background: { bg: 'BASH', pulse: true },
    })

    expect(resolveDispatchDot(
      agent('lead', []),
      { id: 'shell', status: 'suspended', waitingOn: 'shell' } as DispatchInfo,
      [],
      COLORS,
    )).toMatchObject({ bg: 'BASH', pulse: true, glowColor: 'BASH_GLOW' })
  })
})
