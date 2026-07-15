import { describe, it, expect } from 'vitest'
import * as lib from '../agent-helpers'
import * as shim from '../../components/agent-panel-helpers'

/**
 * Relocation regression: agent-panel-helpers moved to renderer/lib/agent-helpers
 * with a re-export shim left behind at the old path. Every runtime export must
 * be the SAME function/object through both paths — if the shim drifts (partial
 * re-export, copied implementation), these identity assertions fail.
 */

const RUNTIME_EXPORTS = [
  'meta',
  'getDispatches',
  'dispatchKey',
  'AGENT_COLORS',
  'getAgentColor',
  'getStatusDot',
  'isRootLevelAgent',
  'isAgentVisible',
  'sortAgents',
  'formatDuration',
  'selectAgentDepths',
  'childrenOfDispatch',
  'childAgentsOf',
  'rootDispatches',
  'buildBreadcrumbStack',
] as const

describe('agent-helpers relocation', () => {
  it('exports every expected symbol from the new lib path', () => {
    for (const name of RUNTIME_EXPORTS) {
      expect(lib[name], name).toBeDefined()
    }
  })

  it('old component path re-exports the identical symbols (no copies)', () => {
    for (const name of RUNTIME_EXPORTS) {
      expect((shim as Record<string, unknown>)[name], name).toBe(lib[name])
    }
  })

  it('AGENT_COLORS is exported and carries the department accent map', () => {
    expect(lib.AGENT_COLORS['dev-lead']).toBe('#8c5ac8')
    expect(Object.keys(lib.AGENT_COLORS).length).toBeGreaterThan(0)
  })
})

// ─── getStatusDot: standardized three-state dot vocabulary ─────────────────
//
// Pins the cascade to the platform tokens (orange running / yellow
// waiting-children / green done). Reverting any branch to a different token
// turns the matching case red.

const DOT_COLORS = {
  statusRunning: '#d97757',
  statusWaitingChildren: '#f59e0b',
  statusWaitingChildrenGlow: 'rgba(245, 158, 11, 0.4)',
  statusComplete: '#7aac8c',
  statusError: '#c47060',
  statusIdle: '#8a8a80',
}

function agentWith(status: string): import('../../../shared/types').AgentStateUpdate {
  return { name: 'a', status, metadata: {} } as import('../../../shared/types').AgentStateUpdate
}

describe('getStatusDot', () => {
  it('running with no running children → pulsing orange, no glow', () => {
    const dot = lib.getStatusDot(agentWith('running'), DOT_COLORS, false)
    expect(dot).toEqual({ bg: DOT_COLORS.statusRunning, pulse: true, glowColor: '' })
  })

  it('running with a running child → pulsing yellow + glow (waiting on children)', () => {
    const dot = lib.getStatusDot(agentWith('running'), DOT_COLORS, true)
    expect(dot).toEqual({
      bg: DOT_COLORS.statusWaitingChildren,
      pulse: true,
      glowColor: DOT_COLORS.statusWaitingChildrenGlow,
    })
  })

  it('done → solid green, no pulse', () => {
    const dot = lib.getStatusDot(agentWith('done'), DOT_COLORS, false)
    expect(dot).toEqual({ bg: DOT_COLORS.statusComplete, pulse: false, glowColor: '' })
  })

  it('error → solid statusError, no pulse (children flag ignored)', () => {
    const dot = lib.getStatusDot(agentWith('error'), DOT_COLORS, true)
    expect(dot).toEqual({ bg: DOT_COLORS.statusError, pulse: false, glowColor: '' })
  })

  it('unknown/idle status → solid statusIdle', () => {
    const dot = lib.getStatusDot(agentWith('idle'), DOT_COLORS, false)
    expect(dot).toEqual({ bg: DOT_COLORS.statusIdle, pulse: false, glowColor: '' })
  })
})
