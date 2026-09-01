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
// Pins the cascade to the platform tokens (statusRunning / statusWaitingChildren
// / statusComplete). Reverting any branch to a different token turns the
// matching case red. The stub values below are arbitrary; assertions compare
// against the stub, so the test is palette-agnostic by design.

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
  it('running with no running children → pulsing statusRunning, no glow', () => {
    const dot = lib.getStatusDot(agentWith('running'), DOT_COLORS, false)
    expect(dot).toEqual({ bg: DOT_COLORS.statusRunning, pulse: true, glowColor: '' })
  })

  it('running with a running child → pulsing statusWaitingChildren + glow', () => {
    const dot = lib.getStatusDot(agentWith('running'), DOT_COLORS, true)
    expect(dot).toEqual({
      bg: DOT_COLORS.statusWaitingChildren,
      pulse: true,
      glowColor: DOT_COLORS.statusWaitingChildrenGlow,
    })
  })

  it('done → solid statusComplete, no pulse', () => {
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

  // ── Waiting-on-children precedes terminal states (dispatch-lifecycle F) ──
  // A parent marked done while a child dispatch still runs must NOT render a
  // solid green done dot: the tree is not finished (the Infra Engineer
  // incident — a lead read complete while its terraform specialist worked).
  // Revert bar: gating hasRunningChildren inside the running branch turns
  // these red.

  it('done with a running child → pulsing statusWaitingChildren + glow (never solid green)', () => {
    const dot = lib.getStatusDot(agentWith('done'), DOT_COLORS, true)
    expect(dot).toEqual({
      bg: DOT_COLORS.statusWaitingChildren,
      pulse: true,
      glowColor: DOT_COLORS.statusWaitingChildrenGlow,
    })
  })

  it('suspended (parked dispatch) → pulsing statusWaitingChildren + glow', () => {
    const dot = lib.getStatusDot(agentWith('suspended'), DOT_COLORS, false)
    expect(dot).toEqual({
      bg: DOT_COLORS.statusWaitingChildren,
      pulse: true,
      glowColor: DOT_COLORS.statusWaitingChildrenGlow,
    })
  })

  it('idle with a running child → pulsing statusWaitingChildren (live tree wins over idle)', () => {
    const dot = lib.getStatusDot(agentWith('idle'), DOT_COLORS, true)
    expect(dot).toEqual({
      bg: DOT_COLORS.statusWaitingChildren,
      pulse: true,
      glowColor: DOT_COLORS.statusWaitingChildrenGlow,
    })
  })
})

/**
 * Roster visibility default.
 *
 * A row whose metadata omits `visibility` used to fall through to 'ephemeral',
 * which drops it the instant its run stops. A dispatched child was therefore
 * gone from its parent's drill-down before an operator could open it, so a
 * completed dispatch always looked as though it had dispatched nothing.
 *
 * Observed live: a poll-check child appeared in seven consecutive agent-state
 * snapshots, every one status=running and correctly attributed to its parent,
 * and no snapshot after the dispatch completed carried it at all.
 *
 * The default is now 'sticky', mirroring the engine
 * (extcontext.resolveDispatchVisibility). Ephemeral is opt-in.
 */
describe('agent visibility default', () => {
  const agent = (status: string, metadata?: Record<string, unknown>) =>
    ({ name: 'poll-check', status, metadata }) as never

  it('defaults the visibility field to sticky', () => {
    expect(lib.DEFAULT_AGENT_VISIBILITY).toBe('sticky')
  })

  /**
   * A metadata-less row is NOT a dispatch. Every real dispatch row is stamped
   * `visibility: sticky` + `invited: true` by the engine (three sites in
   * dispatch_agent.go / dispatch_rehydrate.go), so the case below is an
   * extension-roster row or malformed data.
   *
   * `invited` remains the existing "this sticky agent has been activated"
   * signal, so an un-invited row keeps its previous lifetime — visible while
   * running, gone afterwards. Making bare rows persist forever would change
   * behavior well beyond dispatches, which is not what this default is for.
   */
  it('leaves an un-invited bare row on its previous lifetime', () => {
    expect(lib.isAgentVisible(agent('running'))).toBe(true)
    expect(lib.isAgentVisible(agent('done'))).toBe(false)
  })

  it('keeps a completed dispatched child visible under its parent', () => {
    const child = agent('done', {
      visibility: 'sticky',
      invited: true,
      dispatchParentId: 'dispatch-agent-1',
      dispatchDepth: 2,
    })
    expect(lib.isAgentVisible(child)).toBe(true)
    expect(lib.childAgentsOf([child], 'dispatch-agent-1')).toHaveLength(1)
  })

  it('still honours an explicit ephemeral request', () => {
    expect(lib.isAgentVisible(agent('running', { visibility: 'ephemeral' }))).toBe(true)
    expect(lib.isAgentVisible(agent('done', { visibility: 'ephemeral' }))).toBe(false)
  })

  /**
   * The regression arm. `sticky` normally requires `invited`, so naively
   * flipping the default would HIDE a bare running row that used to be visible
   * via the ephemeral fallback — a regression dressed as a fix.
   */
  it('does not hide a running row that lacks an invited flag', () => {
    expect(lib.isAgentVisible(agent('running'))).toBe(true)
    expect(lib.isAgentVisible(agent('running', { visibility: 'sticky' }))).toBe(true)
  })

  it('keeps always-visible rows visible regardless of status', () => {
    expect(lib.isAgentVisible(agent('done', { visibility: 'always' }))).toBe(true)
  })
})
