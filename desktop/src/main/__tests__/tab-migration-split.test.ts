// @vitest-environment node
/**
 * tab-migration-split — unit tests for the pure split transform and the
 * verify gate.
 *
 * Covers:
 *   - splitMultiInstanceTab equivalent logic at the PersistedTabState level
 *   - verifySplitMigration: happy path + each discrepancy the gate catches
 *   - Idempotency: running the transform twice is a no-op
 */
import { describe, it, expect } from 'vitest'
import {
  migrateTabStateToSplit,
  isSplitSchema,
  SPLIT_SCHEMA_VERSION,
} from '../tab-migration-split'
import { verifySplitMigration } from '../tab-migration-split-runner'
import type {
  PersistedTab,
  PersistedTabState,
  PersistedConversationInstance,
} from '../../shared/types-persistence'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInstance(
  id: string,
  label: string,
  overrides: Partial<PersistedConversationInstance> = {},
): PersistedConversationInstance {
  return {
    id,
    label,
    messages: [
      { role: 'user', content: `Hello from ${label}`, timestamp: 1000 },
      { role: 'assistant', content: `Reply in ${label}`, timestamp: 2000 },
    ],
    messageCount: 2,
    modelOverride: null,
    permissionMode: 'auto',
    conversationIds: [`conv-${id}`],
    draftInput: '',
    agentStates: [],
    ...overrides,
  }
}

function makeTab(overrides: Partial<PersistedTab> = {}): PersistedTab {
  return {
    conversationId: null,
    title: 'Engine',
    customTitle: null,
    workingDirectory: '/project',
    hasChosenDirectory: true,
    additionalDirs: [],
    permissionMode: 'auto',
    hasEngineExtension: true,
    engineProfileId: 'profile-1',
    ...overrides,
  }
}

function makeState(tabs: PersistedTab[], version = 2): PersistedTabState {
  return {
    schemaVersion: version,
    activeSessionId: null,
    tabs,
  }
}

// ─── Pure transform ──────────────────────────────────────────────────────────

describe('migrateTabStateToSplit - pure transform', () => {
  it('splits a 3-instance tab into 3 single-instance tabs', () => {
    const inst1 = makeInstance('a', 'Engine A', {
      modelOverride: 'claude-opus-4-20250514',
      draftInput: 'wip A',
      permissionMode: 'plan',
    })
    const inst2 = makeInstance('b', 'Engine B', {
      messages: [
        { role: 'user', content: 'x', timestamp: 100 },
        { role: 'assistant', content: 'y', timestamp: 200 },
        { role: 'user', content: 'z', timestamp: 300 },
      ],
      messageCount: 3,
      modelOverride: 'claude-sonnet-4-20250514',
    })
    const inst3 = makeInstance('c', 'Engine C', {
      conversationIds: ['conv-c-1', 'conv-c-2'],
    })

    const tab = makeTab({
      conversationId: 'parent',
      conversationPane: {
        instances: [inst1, inst2, inst3],
        activeInstanceId: 'b',
      },
    })

    const result = migrateTabStateToSplit(makeState([tab]))

    expect(result.schemaVersion).toBe(SPLIT_SCHEMA_VERSION)
    expect(result.tabs).toHaveLength(3)

    // Tab 0: inst a
    const t0 = result.tabs[0]
    expect(t0.conversationPane?.instances).toHaveLength(1)
    expect(t0.conversationPane?.instances[0].id).toBe('a')
    expect(t0.conversationPane?.activeInstanceId).toBe('a')
    expect(t0.customTitle).toBe('Engine A')
    expect(t0.conversationId).toBe('conv-a')
    expect(t0.conversationPane!.instances[0].modelOverride).toBe('claude-opus-4-20250514')
    expect(t0.conversationPane!.instances[0].draftInput).toBe('wip A')
    expect(t0.conversationPane!.instances[0].permissionMode).toBe('plan')

    // Tab 1: inst b
    const t1 = result.tabs[1]
    expect(t1.conversationPane?.instances[0].id).toBe('b')
    expect(t1.conversationPane?.instances[0].messages).toHaveLength(3)
    expect(t1.conversationPane?.instances[0].modelOverride).toBe('claude-sonnet-4-20250514')
    expect(t1.conversationId).toBe('conv-b')

    // Tab 2: inst c
    const t2 = result.tabs[2]
    expect(t2.conversationPane?.instances[0].id).toBe('c')
    expect(t2.conversationId).toBe('conv-c-2') // last in chain

    // All tabs inherit parent metadata
    for (const t of result.tabs) {
      expect(t.workingDirectory).toBe('/project')
      expect(t.engineProfileId).toBe('profile-1')
      expect(t.hasEngineExtension).toBe(true)
    }
  })

  it('preserves single-instance tabs untouched', () => {
    const inst = makeInstance('solo', 'Solo')
    const tab = makeTab({
      conversationPane: { instances: [inst], activeInstanceId: 'solo' },
    })
    const result = migrateTabStateToSplit(makeState([tab]))
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0].conversationPane?.instances[0].id).toBe('solo')
  })

  it('preserves terminal-only tabs untouched', () => {
    const tab = makeTab({
      isTerminalOnly: true,
      conversationPane: undefined,
      hasEngineExtension: false,
    })
    const result = migrateTabStateToSplit(makeState([tab]))
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0].isTerminalOnly).toBe(true)
    expect(result.tabs[0].conversationPane).toBeUndefined()
  })

  it('handles mixed tabs: plain + multi-instance + terminal', () => {
    const plain = makeTab({
      hasEngineExtension: false,
      conversationPane: {
        instances: [makeInstance('main', 'main')],
        activeInstanceId: 'main',
      },
    })
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('x', 'X'), makeInstance('y', 'Y')],
        activeInstanceId: 'x',
      },
    })
    const terminal = makeTab({
      isTerminalOnly: true,
      conversationPane: undefined,
      hasEngineExtension: false,
    })

    const result = migrateTabStateToSplit(makeState([plain, multi, terminal]))
    // plain(1) + split(2) + terminal(1) = 4
    expect(result.tabs).toHaveLength(4)
    expect(result.tabs[0].conversationPane?.instances[0].id).toBe('main')
    expect(result.tabs[1].conversationPane?.instances[0].id).toBe('x')
    expect(result.tabs[2].conversationPane?.instances[0].id).toBe('y')
    expect(result.tabs[3].isTerminalOnly).toBe(true)
  })

  it('uses parent conversationId as fallback when instance has no conversationIds', () => {
    const inst = makeInstance('no-conv', 'NoConv', { conversationIds: [] })
    const tab = makeTab({
      conversationId: 'parent-fallback',
      conversationPane: {
        instances: [inst, makeInstance('other', 'Other')],
        activeInstanceId: 'no-conv',
      },
    })
    const result = migrateTabStateToSplit(makeState([tab]))
    expect(result.tabs[0].conversationId).toBe('parent-fallback')
  })

  it('uses instance label as customTitle, falls back to parent customTitle', () => {
    const instNoLabel = makeInstance('nl', '', { conversationIds: ['c1'] })
    const tab = makeTab({
      customTitle: 'Parent Title',
      conversationPane: {
        instances: [instNoLabel, makeInstance('wl', 'With Label')],
        activeInstanceId: 'nl',
      },
    })
    const result = migrateTabStateToSplit(makeState([tab]))
    expect(result.tabs[0].customTitle).toBe('Parent Title') // empty label -> parent
    expect(result.tabs[1].customTitle).toBe('With Label')
  })
})

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('migrateTabStateToSplit - idempotency', () => {
  it('is a no-op when already at SPLIT_SCHEMA_VERSION', () => {
    const inst = makeInstance('a', 'A')
    const tab = makeTab({
      conversationPane: { instances: [inst], activeInstanceId: 'a' },
    })
    const state = makeState([tab], SPLIT_SCHEMA_VERSION)
    const result = migrateTabStateToSplit(state)
    expect(result).toBe(state) // same reference
  })

  it('running twice produces identical output (same reference on second call)', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('x', 'X'), makeInstance('y', 'Y')],
        activeInstanceId: 'x',
      },
    })
    const first = migrateTabStateToSplit(makeState([multi]))
    const second = migrateTabStateToSplit(first)
    expect(second).toBe(first) // isSplitSchema -> same reference
    expect(second.schemaVersion).toBe(SPLIT_SCHEMA_VERSION)
  })

  it('isSplitSchema returns false for version < 3 and true for >= 3', () => {
    expect(isSplitSchema({ schemaVersion: undefined, activeSessionId: null, tabs: [] } as any)).toBe(false)
    expect(isSplitSchema({ schemaVersion: 1, activeSessionId: null, tabs: [] } as any)).toBe(false)
    expect(isSplitSchema({ schemaVersion: 2, activeSessionId: null, tabs: [] } as any)).toBe(false)
    expect(isSplitSchema({ schemaVersion: 3, activeSessionId: null, tabs: [] } as any)).toBe(true)
    expect(isSplitSchema({ schemaVersion: 4, activeSessionId: null, tabs: [] } as any)).toBe(true)
  })
})

// ─── Verify gate ─────────────────────────────────────────────────────────────

describe('verifySplitMigration', () => {
  it('returns null on a valid split (happy path)', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    expect(verifySplitMigration(input, output)).toBeNull()
  })

  it('catches missing schemaVersion', () => {
    const input = makeState([])
    const output: PersistedTabState = { ...input, schemaVersion: 2, tabs: [] }
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('schemaVersion')
  })

  it('catches total instance count mismatch (instance dropped)', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    // Tamper: remove one split tab
    output.tabs.pop()
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('instance count')
  })

  it('catches total instance count mismatch (instance duplicated)', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    // Tamper: duplicate a tab
    output.tabs.push(JSON.parse(JSON.stringify(output.tabs[0])))
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('instance count')
  })

  it('catches output tab still having >1 instance', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    // Build a fake output that stamps version but doesn't actually split
    const output: PersistedTabState = {
      ...input,
      schemaVersion: SPLIT_SCHEMA_VERSION,
    }
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('still has 2 instances')
  })

  it('catches messages differ', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    // Tamper: alter a message
    output.tabs[0].conversationPane!.instances[0].messages = []
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('messages differ')
  })

  it('catches conversationIds differ', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    output.tabs[0].conversationPane!.instances[0].conversationIds = ['wrong']
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('conversationIds differ')
  })

  it('catches modelOverride differ', () => {
    const inst = makeInstance('a', 'A', { modelOverride: 'model-x' })
    const multi = makeTab({
      conversationPane: {
        instances: [inst, makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    output.tabs[0].conversationPane!.instances[0].modelOverride = 'model-y'
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('modelOverride differs')
  })

  it('catches draftInput differ', () => {
    const inst = makeInstance('a', 'A', { draftInput: 'draft text' })
    const multi = makeTab({
      conversationPane: {
        instances: [inst, makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    output.tabs[0].conversationPane!.instances[0].draftInput = 'altered'
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('draftInput differs')
  })

  it('catches permissionMode differ', () => {
    const inst = makeInstance('a', 'A', { permissionMode: 'plan' })
    const multi = makeTab({
      conversationPane: {
        instances: [inst, makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    output.tabs[0].conversationPane!.instances[0].permissionMode = 'auto'
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('permissionMode differs')
  })

  it('catches permissionDenied differ', () => {
    const denied = { tools: [{ toolName: 'AskUser', toolUseId: 'tu-1' }] }
    const inst = makeInstance('a', 'A', { permissionDenied: denied })
    const multi = makeTab({
      conversationPane: {
        instances: [inst, makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    output.tabs[0].conversationPane!.instances[0].permissionDenied = null
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('permissionDenied differs')
  })

  it('catches agentStates differ', () => {
    const agents = [{ name: 'agent-1', status: 'done' }]
    const inst = makeInstance('a', 'A', { agentStates: agents })
    const multi = makeTab({
      conversationPane: {
        instances: [inst, makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    output.tabs[0].conversationPane!.instances[0].agentStates = []
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('agentStates differ')
  })

  it('catches output tab count mismatch', () => {
    const multi = makeTab({
      conversationPane: {
        instances: [makeInstance('a', 'A'), makeInstance('b', 'B')],
        activeInstanceId: 'a',
      },
    })
    const input = makeState([multi])
    const output = migrateTabStateToSplit(input)
    // Tamper: add an extra tab (instance counts still match but tab count wrong)
    const extraTab = makeTab({
      conversationPane: { instances: [], activeInstanceId: null },
    })
    output.tabs.push(extraTab)
    const problem = verifySplitMigration(input, output)
    expect(problem).toContain('output tab count')
  })

  it('validates mixed state: single + multi + terminal', () => {
    const single = makeTab({
      hasEngineExtension: false,
      conversationPane: {
        instances: [makeInstance('main', 'main')],
        activeInstanceId: 'main',
      },
    })
    const multi = makeTab({
      conversationPane: {
        instances: [
          makeInstance('x', 'X', { modelOverride: 'opus' }),
          makeInstance('y', 'Y', { draftInput: 'draft' }),
          makeInstance('z', 'Z', { permissionMode: 'plan' }),
        ],
        activeInstanceId: 'y',
      },
    })
    const terminal = makeTab({
      isTerminalOnly: true,
      conversationPane: undefined,
      hasEngineExtension: false,
    })

    const input = makeState([single, multi, terminal])
    const output = migrateTabStateToSplit(input)
    expect(verifySplitMigration(input, output)).toBeNull()
    // 1 single + 3 split + 1 terminal = 5
    expect(output.tabs).toHaveLength(5)
  })
})
