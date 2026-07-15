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
  'isRootLevelAgent',
  'isAgentVisible',
  'sortAgents',
  'getLabelBg',
  'getStatusSuffix',
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
