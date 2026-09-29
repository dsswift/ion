import { describe, it, expect } from 'vitest'
import { childrenOfDispatch, rootDispatches, selectAgentDepths, isRootLevelAgent, childAgentsOf } from '../agent-panel-helpers'
import type { DispatchTelemetryEntry } from '@ion/shared/types-engine'
import type { AgentStateUpdate } from '@ion/shared/types-engine'

function entry(overrides: Partial<DispatchTelemetryEntry>): DispatchTelemetryEntry {
  return {
    dispatchAgent: 'agent-a',
    dispatchSessionId: 'sess-1',
    dispatchModel: 'claude-sonnet-4-20250514',
    dispatchTask: 'do stuff',
    dispatchDepth: 0,
    dispatchParentId: '',
    dispatchId: 'did-1',
    ...overrides,
  }
}

describe('childrenOfDispatch', () => {
  it('returns entries whose dispatchParentId matches the given dispatchId', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'root-1', dispatchParentId: '', dispatchAgent: 'orchestrator' }),
      entry({ dispatchId: 'child-1', dispatchParentId: 'root-1', dispatchAgent: 'worker-a' }),
      entry({ dispatchId: 'child-2', dispatchParentId: 'root-1', dispatchAgent: 'worker-b' }),
      entry({ dispatchId: 'grandchild-1', dispatchParentId: 'child-1', dispatchAgent: 'sub-worker' }),
    ]

    const children = childrenOfDispatch(telemetry, 'root-1')
    expect(children).toHaveLength(2)
    expect(children.map(c => c.dispatchId)).toEqual(['child-1', 'child-2'])
  })

  it('returns depth-2 children when queried by depth-1 dispatchId', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'A', dispatchParentId: '', dispatchAgent: 'root' }),
      entry({ dispatchId: 'B', dispatchParentId: 'A', dispatchAgent: 'worker' }),
      entry({ dispatchId: 'C', dispatchParentId: 'B', dispatchAgent: 'sub-worker' }),
    ]

    const depth2 = childrenOfDispatch(telemetry, 'B')
    expect(depth2).toHaveLength(1)
    expect(depth2[0].dispatchId).toBe('C')
  })

  it('resolves by dispatchId, not agent name (same-name-different-tier)', () => {
    // Two dispatches with the same agent name but different dispatchIds
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'tier1-A', dispatchParentId: '', dispatchAgent: 'worker' }),
      entry({ dispatchId: 'tier2-A', dispatchParentId: '', dispatchAgent: 'worker' }),
      entry({ dispatchId: 'child-of-1', dispatchParentId: 'tier1-A', dispatchAgent: 'sub' }),
      entry({ dispatchId: 'child-of-2', dispatchParentId: 'tier2-A', dispatchAgent: 'sub' }),
    ]

    const childrenOf1 = childrenOfDispatch(telemetry, 'tier1-A')
    expect(childrenOf1).toHaveLength(1)
    expect(childrenOf1[0].dispatchId).toBe('child-of-1')

    const childrenOf2 = childrenOfDispatch(telemetry, 'tier2-A')
    expect(childrenOf2).toHaveLength(1)
    expect(childrenOf2[0].dispatchId).toBe('child-of-2')
  })

  it('returns empty array when no children match', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'solo', dispatchParentId: '' }),
    ]
    expect(childrenOfDispatch(telemetry, 'solo')).toEqual([])
    expect(childrenOfDispatch(telemetry, 'nonexistent')).toEqual([])
  })
})

describe('rootDispatches', () => {
  it('returns only entries with empty dispatchParentId', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'root-1', dispatchParentId: '', dispatchAgent: 'orchestrator' }),
      entry({ dispatchId: 'root-2', dispatchParentId: '', dispatchAgent: 'monitor' }),
      entry({ dispatchId: 'child-1', dispatchParentId: 'root-1', dispatchAgent: 'worker' }),
    ]

    const roots = rootDispatches(telemetry)
    expect(roots).toHaveLength(2)
    expect(roots.map(r => r.dispatchId)).toEqual(['root-1', 'root-2'])
  })

  it('returns empty for all-nested entries', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'c1', dispatchParentId: 'p1' }),
      entry({ dispatchId: 'c2', dispatchParentId: 'p2' }),
    ]
    expect(rootDispatches(telemetry)).toEqual([])
  })
})

describe('selectAgentDepths', () => {
  it('keys depth by dispatchId (not agent name) so same-name dispatches stay distinct', () => {
    const telemetry: DispatchTelemetryEntry[] = [
      entry({ dispatchId: 'a1', dispatchAgent: 'a', dispatchDepth: 1 }),
      entry({ dispatchId: 'a2', dispatchAgent: 'a', dispatchDepth: 3 }),
      entry({ dispatchId: 'b1', dispatchAgent: 'b', dispatchDepth: 2 }),
    ]
    const depths = selectAgentDepths(telemetry)
    // Each dispatch keeps its own depth; the two 'a' dispatches do not collapse.
    expect(depths.get('a1')).toBe(1)
    expect(depths.get('a2')).toBe(3)
    expect(depths.get('b1')).toBe(2)
  })
})

describe('isRootLevelAgent', () => {
  function agent(meta: Record<string, unknown>): AgentStateUpdate {
    return { name: 'a', status: 'running', metadata: meta } as AgentStateUpdate
  }

  it('treats a direct orchestrator dispatch (depth 1, no parent) as root-level', () => {
    expect(isRootLevelAgent(agent({ dispatchDepth: 1, dispatchParentId: '' }))).toBe(true)
  })

  it('excludes a nested dispatch (depth 2 with a parent)', () => {
    expect(
      isRootLevelAgent(agent({ dispatchDepth: 2, dispatchParentId: 'dispatch-dev-lead-1' })),
    ).toBe(false)
  })

  it('keeps an agent with no attribution visible (back-compat: roster rows, pre-fix state)', () => {
    expect(isRootLevelAgent(agent({}))).toBe(true)
    expect(isRootLevelAgent({ name: 'a', status: 'running' } as AgentStateUpdate)).toBe(true)
  })

  it('is per-instance: a depth-2 pill is excluded even when the same NAME also has a depth-1 pill', () => {
    // The superseded name-based heuristic could not distinguish these and
    // leaked the nested instance into the main panel. Per-instance attribution
    // judges each pill on its own depth/parent.
    const rootPill = agent({ dispatchDepth: 1, dispatchParentId: '' })
    const nestedPill = agent({ dispatchDepth: 2, dispatchParentId: 'dispatch-dev-lead-1' })
    expect(isRootLevelAgent(rootPill)).toBe(true)
    expect(isRootLevelAgent(nestedPill)).toBe(false)
  })
})

describe('childAgentsOf (durable agent-state child derivation)', () => {
  function pill(name: string, parentId: string): AgentStateUpdate {
    return { name, status: 'done', metadata: { dispatchParentId: parentId } } as AgentStateUpdate
  }

  it('returns the agent-state pills whose dispatchParentId matches', () => {
    const agents = [
      pill('dev-lead', ''),
      pill('engine-dev', 'dev-lead-dispatch-1'),
      pill('desktop-dev', 'dev-lead-dispatch-1'),
      pill('qa-reviewer', 'other-dispatch'),
    ]
    const children = childAgentsOf(agents, 'dev-lead-dispatch-1')
    expect(children.map((a) => a.name).sort()).toEqual(['desktop-dev', 'engine-dev'])
  })

  it('returns [] for an empty parentDispatchId (root pills are not children)', () => {
    const agents = [pill('dev-lead', ''), pill('engine-dev', 'dev-lead-dispatch-1')]
    expect(childAgentsOf(agents, '')).toEqual([])
  })

  it('returns [] when no pill matches', () => {
    const agents = [pill('engine-dev', 'dev-lead-dispatch-1')]
    expect(childAgentsOf(agents, 'nonexistent')).toEqual([])
  })

  it('treats a pill with no attribution metadata as a non-child', () => {
    const agents = [{ name: 'roster-row', status: 'idle' } as AgentStateUpdate]
    expect(childAgentsOf(agents, 'dev-lead-dispatch-1')).toEqual([])
  })
})
