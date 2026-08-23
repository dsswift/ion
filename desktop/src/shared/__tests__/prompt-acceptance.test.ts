/**
 * The one predicate both send gates consult.
 *
 * These cases pin the exact semantics the InputBar and submit() used to
 * disagree about — which is how an operator's prompt got cleared from the
 * input on its way to a guard that refused it.
 */
import { describe, it, expect } from 'vitest'
import { promptRefusal } from '../prompt-acceptance'

describe('promptRefusal', () => {
  it('accepts an idle, unlocked, restored tab', () => {
    expect(promptRefusal({ tab: { status: 'idle' }, tabsReady: true })).toBeNull()
  })

  it('accepts a running tab — a mid-turn steer is a legitimate send', () => {
    expect(promptRefusal({ tab: { status: 'running' }, tabsReady: true })).toBeNull()
  })

  it('refuses when no tab resolves', () => {
    expect(promptRefusal({ tab: null })?.reason).toBe('no-tab')
    expect(promptRefusal({})?.reason).toBe('no-tab')
  })

  it('refuses while the session is connecting', () => {
    expect(promptRefusal({ tab: { status: 'connecting' } })?.reason).toBe('connecting')
  })

  it('refuses before tab state has finished restoring', () => {
    expect(promptRefusal({ tab: { status: 'idle' }, tabsReady: false })?.reason).toBe('tabs-not-ready')
  })

  it('ignores restore state when the caller does not pass it', () => {
    // submit() omits tabsReady so a remote prompt during startup keeps being
    // accepted; narrowing that is a separate decision from this fix.
    expect(promptRefusal({ tab: { status: 'idle' } })).toBeNull()
  })

  it('refuses an operator prompt on a locked conversation', () => {
    const r = promptRefusal({ tab: { status: 'idle', inputLocked: true, inputLockReason: 'conflict-fix' } })
    expect(r?.reason).toBe('input-locked')
    expect(r?.detail).toContain('conflict-fix')
  })

  it('lets the auto-fix flow past the lock it installed itself', () => {
    expect(promptRefusal({
      tab: { status: 'idle', inputLocked: true, inputLockReason: 'conflict-fix' },
      source: 'machine',
    })).toBeNull()
  })

  it('refuses even a machine prompt on a terminal lock', () => {
    for (const reason of ['landed-worktree', 'settled']) {
      expect(promptRefusal({
        tab: { status: 'idle', inputLocked: true, inputLockReason: reason },
        source: 'machine',
      })?.reason).toBe('input-locked')
    }
  })

  it('allows a normal prompt at the effective context limit so the engine can compact', () => {
    const tab = { status: 'idle', contextTokens: 100, contextLimit: 100 }
    expect(promptRefusal({ tab })).toBeNull()
  })

  it('orders lock refusal before other tab state', () => {
    expect(promptRefusal({
      tab: { status: 'idle', inputLocked: true, contextTokens: 100, contextLimit: 100 },
    })?.reason).toBe('input-locked')
  })

  it('orders refusals so the most fundamental one is reported', () => {
    // A tab that is both un-restored and connecting reports the restore state:
    // the log line should name the condition the operator can actually wait out.
    expect(promptRefusal({
      tab: { status: 'connecting', inputLocked: true },
      tabsReady: false,
    })?.reason).toBe('tabs-not-ready')
  })
})
