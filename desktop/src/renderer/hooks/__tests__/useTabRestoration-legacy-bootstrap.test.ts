/**
 * fix(desktop): drop legacy bootstrap markers on restore
 *
 * Legacy harness messages (role:'harness', content starts with
 * 'Session bootstrapped:', no dedupKey) accumulated before the relocate
 * dedup mode was introduced (up to 5,712 objects in tabs-api.json).
 * buildPopulatedInstance now drops them on restore so they don't survive
 * the next serialize cycle.
 *
 * Keyed harness messages (dedupKey present) must be preserved — they are
 * managed by the relocate/suppress-later dedup logic after restore.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock transitive dependencies that buildPopulatedInstance does not use but
// that get pulled in through the module graph of useTabRestoration-engine.ts.
vi.mock('../../../renderer/stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))
vi.mock('../../stores/session-store-persistence', () => ({
  isExtensionErrorMessage: () => false,
}))

import { buildPopulatedInstance } from '../useTabRestoration-engine'

function makePersistedInst(messages: any[]): any {
  return {
    id: 'main',
    label: 'main',
    messages,
    permissionMode: 'auto' as const,
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    planFilePath: null,
  }
}

const NOOP_TAB: any = {
  permissionMode: 'auto' as const,
  conversationId: null,
  historicalSessionIds: [],
}

describe('buildPopulatedInstance — legacy bootstrap marker removal', () => {
  it('drops legacy harness bootstrap markers (no dedupKey) on restore', () => {
    const inst = makePersistedInst([
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1000 },
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1001 },
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1002 },
      { role: 'assistant', content: 'Hello', timestamp: 1003 },
    ])

    const result = buildPopulatedInstance(inst, 'tab1', NOOP_TAB)

    const bootstrapMsgs = result.messages.filter(
      (m) => m.role === 'harness' && (m.content || '').startsWith('Session bootstrapped:'),
    )
    expect(bootstrapMsgs).toHaveLength(0)
    // Non-bootstrap messages survive
    const assistantMsgs = result.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
  })

  it('preserves keyed harness messages (dedupKey present)', () => {
    const inst = makePersistedInst([
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1000, dedupKey: 'ion-meta:bootstrap' },
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1001 },
    ])

    const result = buildPopulatedInstance(inst, 'tab1', NOOP_TAB)

    // Keyed one kept, unkeyed one dropped
    const harnessAll = result.messages.filter((m) => m.role === 'harness')
    expect(harnessAll).toHaveLength(1)
    expect((harnessAll[0] as any).dedupKey).toBe('ion-meta:bootstrap')
  })

  it('zero legacy markers survive — clean slate for relocate emission', () => {
    const inst = makePersistedInst([
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1000 },
      { role: 'harness', content: 'Session bootstrapped: ion-meta v1', timestamp: 1001 },
    ])

    const result = buildPopulatedInstance(inst, 'tab1', NOOP_TAB)

    expect(result.messages.filter((m) => m.role === 'harness')).toHaveLength(0)
  })
})
