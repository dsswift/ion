/**
 * useTabRestoration-engine — multi-instance split migration test
 *
 * Conversation unification #256 phase 1: pins the one-time migration that
 * splits a legacy multi-instance engine tab into N standalone single-instance
 * tabs. Asserts:
 *   - A 3-instance legacy tab produces 3 output tabs.
 *   - Each output tab preserves its instance's full conversation history,
 *     conversationIds, modelOverride, draftInput, label, and permissionMode.
 *   - The active tab matches the previously-active instance.
 *   - A single-instance tab passes through unchanged.
 *   - The migration is idempotent (a second run does not re-split).
 */

import { describe, it, expect, vi } from 'vitest'

// Mock transitive dependencies that splitMultiInstanceTab does not use but
// that get pulled in through the module graph of useTabRestoration-engine.ts.
vi.mock('../sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))
vi.mock('../session-store-persistence', () => ({
  isExtensionErrorMessage: () => false,
}))

import { splitMultiInstanceTab, buildPopulatedInstance } from '../../hooks/useTabRestoration-engine'
import type { PersistedTab, PersistedConversationInstance } from '../../../shared/types-persistence'
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'

function makePersistedInstance(
  id: string,
  label: string,
  overrides: Partial<PersistedConversationInstance> = {},
): PersistedConversationInstance {
  return {
    id,
    label,
    messages: [
      { role: 'user', content: `Hello from ${label}`, timestamp: 1000 },
      { role: 'assistant', content: `Response in ${label}`, timestamp: 2000 },
    ],
    messageCount: 2,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    planFilePath: null,
    ...overrides,
  }
}

function makePersistedTab(overrides: Partial<PersistedTab> = {}): PersistedTab {
  return {
    conversationId: null,
    title: 'Engine',
    customTitle: null,
    workingDirectory: '/tmp/project',
    hasChosenDirectory: true,
    additionalDirs: [],
    permissionMode: 'auto',
    engineProfileId: 'profile-1',
    ...overrides,
  }
}

describe('splitMultiInstanceTab', () => {
  it('splits a 3-instance tab into 3 tabs, each preserving full instance state', () => {
    const inst1 = makePersistedInstance('inst-a', 'Engine 1', {
      conversationIds: ['conv-aaa'],
      modelOverride: 'claude-opus-4-20250514',
      draftInput: 'pending input A',
      permissionMode: 'plan',
    })
    const inst2 = makePersistedInstance('inst-b', 'Engine 2', {
      conversationIds: ['conv-bbb'],
      modelOverride: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'msg-b1', timestamp: 100 },
        { role: 'assistant', content: 'msg-b2', timestamp: 200 },
        { role: 'user', content: 'msg-b3', timestamp: 300 },
      ],
    })
    const inst3 = makePersistedInstance('inst-c', 'Engine 3', {
      conversationIds: ['conv-ccc-1', 'conv-ccc-2'],
      draftInput: 'pending input C',
    })

    const tab = makePersistedTab({
      conversationId: 'parent-conv',
      conversationPane: {
        instances: [inst1, inst2, inst3],
        activeInstanceId: 'inst-b',
      },
    })

    const { tabs, activeLocalIndex } = splitMultiInstanceTab(tab)

    // 3 instances -> 3 tabs
    expect(tabs).toHaveLength(3)

    // Active instance was inst-b (index 1)
    expect(activeLocalIndex).toBe(1)

    // Tab 0: inst-a
    const t0 = tabs[0]
    expect(t0.conversationPane?.instances).toHaveLength(1)
    expect(t0.conversationPane?.instances[0].id).toBe('inst-a')
    expect(t0.conversationPane?.activeInstanceId).toBe('inst-a')
    expect(t0.customTitle).toBe('Engine 1')
    expect(t0.conversationId).toBe('conv-aaa')
    // Full state preserved on the instance
    const t0inst = t0.conversationPane!.instances[0]
    expect(t0inst.modelOverride).toBe('claude-opus-4-20250514')
    expect(t0inst.draftInput).toBe('pending input A')
    expect(t0inst.permissionMode).toBe('plan')
    expect(t0inst.conversationIds).toEqual(['conv-aaa'])
    expect(t0inst.messages).toHaveLength(2)

    // Tab 1: inst-b (the previously active instance)
    const t1 = tabs[1]
    expect(t1.conversationPane?.instances).toHaveLength(1)
    expect(t1.conversationPane?.instances[0].id).toBe('inst-b')
    expect(t1.customTitle).toBe('Engine 2')
    expect(t1.conversationId).toBe('conv-bbb')
    const t1inst = t1.conversationPane!.instances[0]
    expect(t1inst.modelOverride).toBe('claude-sonnet-4-20250514')
    expect(t1inst.messages).toHaveLength(3)

    // Tab 2: inst-c
    const t2 = tabs[2]
    expect(t2.conversationPane?.instances).toHaveLength(1)
    expect(t2.conversationPane?.instances[0].id).toBe('inst-c')
    expect(t2.customTitle).toBe('Engine 3')
    // Uses last conversationId from the instance's chain
    expect(t2.conversationId).toBe('conv-ccc-2')
    const t2inst = t2.conversationPane!.instances[0]
    expect(t2inst.draftInput).toBe('pending input C')
    expect(t2inst.conversationIds).toEqual(['conv-ccc-1', 'conv-ccc-2'])

    // All tabs inherit parent fields
    for (const t of tabs) {
      expect(t.workingDirectory).toBe('/tmp/project')
      expect(t.engineProfileId).toBe('profile-1')
    }
  })

  it('passes through a single-instance tab unchanged', () => {
    const inst = makePersistedInstance('inst-single', 'Engine 1')
    const tab = makePersistedTab({
      conversationPane: {
        instances: [inst],
        activeInstanceId: 'inst-single',
      },
    })

    const { tabs, activeLocalIndex } = splitMultiInstanceTab(tab)
    expect(tabs).toHaveLength(1)
    expect(activeLocalIndex).toBe(0)
    // Returns the original tab object (referential identity)
    expect(tabs[0]).toBe(tab)
  })

  it('handles a tab with no instances (empty pane)', () => {
    const tab = makePersistedTab({
      conversationPane: { instances: [], activeInstanceId: null },
    })

    const { tabs, activeLocalIndex } = splitMultiInstanceTab(tab)
    expect(tabs).toHaveLength(1)
    expect(activeLocalIndex).toBe(0)
    expect(tabs[0]).toBe(tab)
  })

  it('handles a tab with no conversationPane at all', () => {
    const tab = makePersistedTab({
      conversationPane: undefined,
    })

    const { tabs, activeLocalIndex } = splitMultiInstanceTab(tab)
    expect(tabs).toHaveLength(1)
    expect(activeLocalIndex).toBe(0)
  })

  it('defaults activeLocalIndex to 0 when activeInstanceId is not found', () => {
    const inst1 = makePersistedInstance('inst-x', 'Engine X')
    const inst2 = makePersistedInstance('inst-y', 'Engine Y')
    const tab = makePersistedTab({
      conversationPane: {
        instances: [inst1, inst2],
        activeInstanceId: 'nonexistent-id',
      },
    })

    const { tabs, activeLocalIndex } = splitMultiInstanceTab(tab)
    expect(tabs).toHaveLength(2)
    // Falls back to 0 since 'nonexistent-id' doesn't match any instance
    expect(activeLocalIndex).toBe(0)
  })

  it('marks split tabs with _multiInstanceSplit for idempotency', () => {
    const inst1 = makePersistedInstance('inst-1', 'A')
    const inst2 = makePersistedInstance('inst-2', 'B')
    const tab = makePersistedTab({
      conversationPane: {
        instances: [inst1, inst2],
        activeInstanceId: 'inst-1',
      },
    })

    const { tabs } = splitMultiInstanceTab(tab)
    // Both split tabs carry the marker
    for (const t of tabs) {
      expect((t as any)._multiInstanceSplit).toBe(true)
    }
  })

  it('uses parent conversationId as fallback when instance has no conversationIds', () => {
    const inst1 = makePersistedInstance('inst-1', 'A', { conversationIds: [] })
    const inst2 = makePersistedInstance('inst-2', 'B', { conversationIds: [] })
    const tab = makePersistedTab({
      conversationId: 'parent-fallback',
      conversationPane: {
        instances: [inst1, inst2],
        activeInstanceId: 'inst-1',
      },
    })

    const { tabs } = splitMultiInstanceTab(tab)
    // Both tabs fall back to the parent conversationId
    expect(tabs[0].conversationId).toBe('parent-fallback')
    expect(tabs[1].conversationId).toBe('parent-fallback')
  })
})

describe('buildPopulatedInstance — instance-id normalization (#256 Defect 1)', () => {
  // The unify migration persisted each instance with its original UUID id.
  // buildPopulatedInstance must normalize the restored instance id to
  // MAIN_INSTANCE_ID so bare-key engine writes (which parse to 'main') land.
  // Reverting the normalization makes these go red.
  it('normalizes a UUID-id persisted instance to MAIN_INSTANCE_ID', () => {
    const inst = makePersistedInstance('3f9c1e02-7a44-4b21-9c0e-aa11bb22cc33', 'Engine 1')
    const st = makePersistedTab()

    const populated = buildPopulatedInstance(inst, 'tab-1', st)

    expect(populated.id).toBe(MAIN_INSTANCE_ID)
  })

  it('preserves all other restored instance data while normalizing the id', () => {
    const inst = makePersistedInstance('some-uuid', 'Engine 1', {
      conversationIds: ['conv-1', 'conv-2'],
      modelOverride: 'claude-opus-4-6',
      draftInput: 'a pending draft',
    })
    const st = makePersistedTab()

    const populated = buildPopulatedInstance(inst, 'tab-1', st)

    expect(populated.id).toBe(MAIN_INSTANCE_ID)
    expect(populated.conversationIds).toEqual(['conv-1', 'conv-2'])
    expect(populated.modelOverride).toBe('claude-opus-4-6')
    expect(populated.draftInput).toBe('a pending draft')
    expect(populated.messageCount).toBe(2)
  })

  it('normalizes even when the persisted id is already main (idempotent)', () => {
    const inst = makePersistedInstance(MAIN_INSTANCE_ID, 'Engine 1')
    const st = makePersistedTab()

    const populated = buildPopulatedInstance(inst, 'tab-1', st)

    expect(populated.id).toBe(MAIN_INSTANCE_ID)
  })

  // Plan-file continuity: an extension-hosted plan-mode conversation must keep
  // its plan file across restart. Previously buildPopulatedInstance hardcoded
  // planFilePath: null, which dropped the persisted path on every engine-tab
  // restore and forced the next plan-mode prompt to allocate a fresh slug.
  // Reverting line ~422 to `planFilePath: null` makes this go red.
  it('restores the persisted planFilePath onto the populated instance', () => {
    const inst = makePersistedInstance('some-uuid', 'Engine 1', {
      permissionMode: 'plan',
      planFilePath: '/Users/josh/.ion/plans/bold-guiding-kite.md',
    })
    const st = makePersistedTab()

    const populated = buildPopulatedInstance(inst, 'tab-1', st)

    expect(populated.planFilePath).toBe('/Users/josh/.ion/plans/bold-guiding-kite.md')
    expect(populated.permissionMode).toBe('plan')
  })

  it('leaves planFilePath null when none was persisted', () => {
    const inst = makePersistedInstance('some-uuid', 'Engine 1')
    const st = makePersistedTab()

    const populated = buildPopulatedInstance(inst, 'tab-1', st)

    expect(populated.planFilePath).toBeNull()
  })
})

