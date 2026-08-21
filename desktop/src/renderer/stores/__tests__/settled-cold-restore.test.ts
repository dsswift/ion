/**
 * Settled tab cold restore — pins the durable behaviour:
 *
 *  1. `isPersistedSettled` returns true iff `settledOverride === 'settled'`.
 *  2. `resolvedInputLock` yields `{ inputLocked: true, inputLockReason: 'settled' }`
 *     for settled tabs, regardless of prior lock state.
 *  3. `resolvedInputLock` preserves the settled > landed-worktree > persisted
 *     priority chain.
 *  4. `startRestoredSessions` skips engine session start for settled tabs.
 *
 * These are pure-function / structural tests (no React, no store). They pin the
 * contract at the helper seam so a future refactor cannot silently re-enable
 * engine bootstrap for settled tabs.
 */

import { describe, it, expect, vi } from 'vitest'

// ─── Pure helpers (no transitive module-graph mocks needed) ─────────────────

import { isPersistedSettled } from '../../../shared/tab-predicates'
import { resolvedInputLock } from '../../hooks/useTabRestoration-helpers'

// ─── isPersistedSettled ─────────────────────────────────────────────────────

describe('isPersistedSettled', () => {
  it('returns true for settledOverride === "settled"', () => {
    expect(isPersistedSettled({ settledOverride: 'settled' })).toBe(true)
  })

  it('returns false for settledOverride === "active"', () => {
    expect(isPersistedSettled({ settledOverride: 'active' })).toBe(false)
  })

  it('returns false for null settledOverride', () => {
    expect(isPersistedSettled({ settledOverride: null })).toBe(false)
  })

  it('returns false when settledOverride is absent', () => {
    expect(isPersistedSettled({})).toBe(false)
  })
})

// ─── resolvedInputLock ──────────────────────────────────────────────────────

function tab(overrides: Record<string, unknown> = {}) {
  return {
    workingDirectory: '/tmp',
    ...overrides,
  } as Parameters<typeof resolvedInputLock>[0]
}

describe('resolvedInputLock', () => {
  it('settled wins over all other lock reasons', () => {
    const result = resolvedInputLock(
      tab({ settledOverride: 'settled', inputLocked: false, inputLockReason: 'automated-workflow' }),
      null,
    )
    expect(result).toEqual({ inputLocked: true, inputLockReason: 'settled' })
  })

  it('settled wins over landed-worktree', () => {
    const result = resolvedInputLock(
      tab({ settledOverride: 'settled' }),
      { landedAt: Date.now() },
    )
    expect(result).toEqual({ inputLocked: true, inputLockReason: 'settled' })
  })

  it('landed-worktree applies when not settled', () => {
    const result = resolvedInputLock(
      tab({ settledOverride: null }),
      { landedAt: Date.now() },
    )
    expect(result).toEqual({ inputLocked: true, inputLockReason: 'landed-worktree' })
  })

  it('falls back to persisted lock fields', () => {
    const result = resolvedInputLock(
      tab({ inputLocked: true, inputLockReason: 'automated-workflow' }),
      null,
    )
    expect(result).toEqual({ inputLocked: true, inputLockReason: 'automated-workflow' })
  })

  it('defaults to unlocked when nothing applies', () => {
    const result = resolvedInputLock(tab(), null)
    expect(result).toEqual({ inputLocked: false, inputLockReason: null })
  })

  it('handles undefined worktree arg', () => {
    const result = resolvedInputLock(tab({ settledOverride: 'settled' }))
    expect(result).toEqual({ inputLocked: true, inputLockReason: 'settled' })
  })
})

// ─── startRestoredSessions settled skip ─────────────────────────────────────

// The session-start module imports `window.ion.*` transitively; mock the heavy
// IPC surface so the pure ordering + guard logic is testable.
vi.mock('../sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))

import { startRestoredSessions } from '../../hooks/useTabRestoration-sessions'

function savedTab(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    workingDirectory: '/tmp',
    worktree: null,
    settledOverride: null,
    ...overrides,
  } as any
}

describe('startRestoredSessions skips settled tabs', () => {
  it('does not call ensureEngineSession for a settled tab', async () => {
    const ensureSpy = vi.fn().mockResolvedValue({ ok: true })
    globalThis.window = {
      ion: { ensureEngineSession: ensureSpy } as any,
    } as any

    const tabs = [
      savedTab({ settledOverride: 'settled', conversationId: 'conv-settled' }),
      savedTab({ conversationId: 'conv-active' }),
    ]
    const refs = [
      { tabId: 'tab-1', sessionId: 'conv-settled', index: 0 },
      { tabId: 'tab-2', sessionId: 'conv-active', index: 1 },
    ]

    await startRestoredSessions(
      refs,
      tabs,
      -1,
      new Map([[0, true], [1, true]]),
      () => false,
    )

    // Only the non-settled tab should have its session started.
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(ensureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-2' }),
    )
  })

  it('skips both landed and settled without reaching ensureEngineSession', async () => {
    const ensureSpy = vi.fn().mockResolvedValue({ ok: true })
    globalThis.window = {
      ion: { ensureEngineSession: ensureSpy } as any,
    } as any

    const tabs = [
      savedTab({ settledOverride: 'settled', conversationId: 'a' }),
      savedTab({ worktree: { landedAt: 123, worktreePath: '/wt', repoPath: '/repo', branchName: 'wt/x', sourceBranch: 'main' }, conversationId: 'b' }),
    ]
    const refs = [
      { tabId: 't1', sessionId: 'a', index: 0 },
      { tabId: 't2', sessionId: 'b', index: 1 },
    ]

    await startRestoredSessions(refs, tabs, -1, new Map(), () => false)
    expect(ensureSpy).not.toHaveBeenCalled()
  })
})
