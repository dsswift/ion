/**
 * Defect 3 regression: restored assistant messages must carry sealed=true so
 * incoming engine_text_delta events do not append to historical content.
 *
 * Root cause: buildPopulatedInstance was not setting sealed=true on assistant
 * messages. When engine_text_delta arrived for the new turn, the delta handler
 * checked `last.role === 'assistant' && !last.sealed` and appended to the
 * stale historical message instead of creating a fresh one — duplicating the
 * old text alongside the new response in the same bubble.
 *
 * Revert-test contract: removing `...(m.role === 'assistant' ? { sealed: true } : {})`
 * from the restoredMessages map in buildPopulatedInstance causes the
 * "sealed=true on restored assistant message" test to fail because the
 * returned message will have no sealed property.
 *
 * Also pins the Defect 1 restore guard: buildPopulatedInstance must force
 * permissionMode='auto' when the persisted messages contain an "Implementing
 * plan" divider. Removing hasPlanBeenImplemented check from buildPopulatedInstance
 * causes the permissionMode-coerce tests to fail.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock transitive dependencies that buildPopulatedInstance does not use but
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

import { buildPopulatedInstance, hasPlanBeenImplemented } from '../../hooks/useTabRestoration-engine'

// Minimal PersistedConversationInstance for testing.
function makePersistedInstance(messages: Array<{ role: string; content: string; timestamp: number }>, extra: Record<string, unknown> = {}) {
  return {
    id: 'main',
    label: 'test',
    messages,
    permissionMode: 'auto' as const,
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    planFilePath: null,
    ...extra,
  }
}

const NOOP_TAB = {
  permissionMode: 'auto' as const,
  conversationId: null,
  historicalSessionIds: [],
  title: '',
  customTitle: null,
  workingDirectory: '/tmp',
  hasChosenDirectory: false,
  additionalDirs: [],
  permissionDenied: null,
}

// ─── Defect 3: sealed assistant messages ────────────────────────────────────

describe('Defect 3 — restored assistant messages carry sealed=true', () => {
  it('sets sealed=true on restored assistant messages', () => {
    const inst = makePersistedInstance([
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'assistant', content: 'world', timestamp: 2000 },
    ])
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    const assistantMsg = populated.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect((assistantMsg as any).sealed).toBe(true)
  })

  it('does NOT set sealed on non-assistant messages (user, system)', () => {
    const inst = makePersistedInstance([
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'system', content: '── Plan created at 12:00 PM ──', timestamp: 2000 },
      { role: 'assistant', content: 'world', timestamp: 3000 },
    ])
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)

    const userMsg = populated.messages.find((m) => m.role === 'user')
    const sysMsg = populated.messages.find((m) => m.role === 'system')
    const asstMsg = populated.messages.find((m) => m.role === 'assistant')

    expect((userMsg as any).sealed).toBeUndefined()
    expect((sysMsg as any).sealed).toBeUndefined()
    expect((asstMsg as any).sealed).toBe(true)
  })

  it('handles empty message list without error', () => {
    const inst = makePersistedInstance([])
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    expect(populated.messages).toHaveLength(0)
  })

  it('preserves planFilePath on a restored plan-lifecycle divider (link survives restart)', () => {
    // The serializer persists planFilePath on divider system rows; restoration
    // must carry it back so the slug stays clickable after a restart. Dropping
    // it would leave the "Plan created · slug" text intact but break the link
    // (SystemMessage.hasPlanLink requires message.planFilePath).
    const inst = makePersistedInstance([
      {
        role: 'system',
        content: '── Plan created at 12:00 PM · happy-rabbit ──',
        timestamp: 2000,
        // PersistedMessage carries planFilePath for divider rows.
        planFilePath: '/tmp/happy-rabbit.md',
      } as any,
    ])
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    const sysMsg = populated.messages.find((m) => m.role === 'system')
    expect(sysMsg).toBeDefined()
    expect((sysMsg as any).planFilePath).toBe('/tmp/happy-rabbit.md')
  })

  it('seals all assistant messages when multiple exist', () => {
    const inst = makePersistedInstance([
      { role: 'assistant', content: 'first', timestamp: 1000 },
      { role: 'user', content: 'follow up', timestamp: 2000 },
      { role: 'assistant', content: 'second', timestamp: 3000 },
    ])
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    const assistantMsgs = populated.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(2)
    for (const m of assistantMsgs) {
      expect((m as any).sealed).toBe(true)
    }
  })
})

// ─── Defect 1 restore guard ─────────────────────────────────────────────────
// Pins hasPlanBeenImplemented and the permissionMode coerce inside
// buildPopulatedInstance. Removing the hasPlanBeenImplemented check from
// buildPopulatedInstance causes the force-auto tests to fail.

describe('hasPlanBeenImplemented', () => {
  it('returns true when messages contain an Implementing divider', () => {
    const messages = [
      { role: 'system', content: '── Plan created at 12:00 PM ──', timestamp: 1000 },
      { role: 'assistant', content: 'Here is the plan', timestamp: 2000 },
      { role: 'system', content: '── Implementing plan at 12:05 PM ──', timestamp: 3000 },
    ]
    expect(hasPlanBeenImplemented(messages as any)).toBe(true)
  })

  it('returns false when no Implementing divider exists', () => {
    const messages = [
      { role: 'system', content: '── Plan created at 12:00 PM ──', timestamp: 1000 },
      { role: 'assistant', content: 'Here is the plan', timestamp: 2000 },
    ]
    expect(hasPlanBeenImplemented(messages as any)).toBe(false)
  })

  it('returns false for empty array', () => {
    expect(hasPlanBeenImplemented([])).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(hasPlanBeenImplemented(undefined)).toBe(false)
  })

  it('buildPopulatedInstance forces permissionMode auto when Implementing divider present', () => {
    const inst = makePersistedInstance([
      { role: 'system', content: '── Plan created at 12:00 PM ──', timestamp: 1000 },
      { role: 'assistant', content: 'The plan is ready', timestamp: 2000 },
      { role: 'system', content: '── Implementing plan at 12:05 PM ──', timestamp: 3000 },
    ], { permissionMode: 'plan' })

    const populated = buildPopulatedInstance(inst as any, 'tab1', {
      ...NOOP_TAB,
      permissionMode: 'plan',
    } as any)

    // Even though inst.permissionMode === 'plan', the Implementing divider
    // in the messages must force permissionMode back to 'auto'.
    expect(populated.permissionMode).toBe('auto')
  })

  it('buildPopulatedInstance keeps permissionMode plan when no Implementing divider', () => {
    const inst = makePersistedInstance([
      { role: 'system', content: '── Plan created at 12:00 PM ──', timestamp: 1000 },
      { role: 'assistant', content: 'The plan is ready', timestamp: 2000 },
    ], { permissionMode: 'plan' })

    const populated = buildPopulatedInstance(inst as any, 'tab1', {
      ...NOOP_TAB,
      permissionMode: 'plan',
    } as any)

    // No Implementing divider → plan is still pending approval → restore as plan.
    expect(populated.permissionMode).toBe('plan')
  })
})

// ─── Schema v4 externalized content: historyHydrated gate ───────────────────

describe('buildPopulatedInstance — externalContentStatus pending sets historyHydrated: false', () => {
  it('sets both externalContentStatus: pending AND historyHydrated: false when hasExternalContent is true and no messages restored', () => {
    // Regression pin: without historyHydrated:false, the legacy heuristic in
    // needsHistoryHydration fires (historyHydrated===undefined → messages.length===0 && count>0).
    // A live bootstrap harness message landing before the user opens the tab makes
    // messages.length===1 → needsHistoryHydration returns false → loadSkeletonMessages is
    // never called → the real conversation from the engine chain is never loaded.
    const inst = makePersistedInstance([], { hasExternalContent: true, messageCount: 5 })
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    expect(populated.externalContentStatus).toBe('pending')
    expect(populated.historyHydrated).toBe(false)
  })

  it('does NOT set externalContentStatus or historyHydrated when hasExternalContent is false', () => {
    const inst = makePersistedInstance([{ role: 'user', content: 'hi', timestamp: 1 }])
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    expect(populated.externalContentStatus).toBeUndefined()
    expect(populated.historyHydrated).toBeUndefined()
  })

  it('sets pending even when messages were eager-merged (stale-content-file guard)', () => {
    // The main process eager-merges the boot-active tab's content file into
    // inst.messages. Those rows render instantly (view readiness) — but the
    // content file may be STALE (written after a session recycle cleared the
    // pane), missing the real conversation rows that only the engine chain
    // has. The pending marker stays so hydration re-merges content + chain.
    const inst = makePersistedInstance(
      [{ role: 'harness', content: 'banner', timestamp: 1 }],
      { hasExternalContent: true },
    )
    const populated = buildPopulatedInstance(inst as any, 'tab1', NOOP_TAB as any)
    expect(populated.externalContentStatus).toBe('pending')
    expect(populated.historyHydrated).toBe(false)
    // Eager-merged rows still present for instant render.
    expect(populated.messages).toHaveLength(1)
  })
})
