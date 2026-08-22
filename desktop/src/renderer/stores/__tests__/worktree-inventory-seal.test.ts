/**
 * Quiescence of the inventory refresh + landed-worktree seal.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * `refreshWorktreeInventory` is called from a render-driven effect (the Studio
 * Inbox refreshes the projects it displays). Two things in this slice made that
 * call self-sustaining:
 *
 *   1. the refresh wrote `new Map(...)` unconditionally, so every pass notified
 *      every subscriber even when git had returned an identical inventory; and
 *   2. `sealLandedWorktree` re-sealed already-sealed tabs, handing them new
 *      object identities and re-issuing `engineStop` on each pass.
 *
 * Either one alone turns "refresh what I render" into refresh → notify →
 * re-render → refresh. Observed in production at ~800 passes/sec with a
 * renderer pinned at 107% CPU and 4.2 GB RSS, and ~1550 `engine_stop` calls per
 * 25 seconds hammering the engine daemon.
 *
 * So the property under test is QUIESCENCE, not "the refresh works": a second
 * refresh over unchanged git state must produce no store write and no engine
 * traffic. Each assertion below fails against the pre-fix slice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ aiGeneratedTitles: false }) },
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { harness, ion, entry, resetIon, REPO, WT_A } from './helpers/worktree-inventory-harness'

beforeEach(resetIon)

describe('refreshWorktreeInventory quiescence', () => {
  it('does not rewrite the cache when git returns an unchanged inventory', async () => {
    const { state, slice } = harness()

    await slice.refreshWorktreeInventory!(REPO)
    const first = state.worktreeInventory.get(REPO)
    await slice.refreshWorktreeInventory!(REPO)

    // Identity, not deep equality: a fresh array with equal contents is exactly
    // what notifies every subscriber and restarts the loop.
    expect(state.worktreeInventory.get(REPO)).toBe(first)
  })

  it('does rewrite the cache when the inventory actually changed', async () => {
    const { state, slice } = harness()
    await slice.refreshWorktreeInventory!(REPO)
    const first = state.worktreeInventory.get(REPO)

    ion.gitWorktreeInventory.mockResolvedValueOnce({
      worktrees: [entry({ isDirty: true })],
    })
    await slice.refreshWorktreeInventory!(REPO)

    expect(state.worktreeInventory.get(REPO)).not.toBe(first)
    expect(state.worktreeInventory.get(REPO)![0].isDirty).toBe(true)
  })
})

describe('sealLandedWorktree idempotence', () => {
  it('stops each conversation once, however many times it is called', async () => {
    const { state, slice } = harness({
      tabs: [{ id: 'tab-1', workingDirectory: WT_A, worktree: { landedAt: null } }],
    })

    await slice.sealLandedWorktree!(WT_A)
    await slice.sealLandedWorktree!(WT_A)
    await slice.sealLandedWorktree!(WT_A)

    expect(ion.engineStop).toHaveBeenCalledTimes(1)
    expect(ion.engineStop).toHaveBeenCalledWith('tab-1')
    expect(state.tabs[0].inputLocked).toBe(true)
    expect(state.tabs[0].inputLockReason).toBe('landed-worktree')
  })

  it('leaves an already-sealed tab object untouched', async () => {
    const { state, slice } = harness({
      tabs: [{ id: 'tab-1', workingDirectory: WT_A, worktree: { landedAt: null } }],
    })

    await slice.sealLandedWorktree!(WT_A)
    const sealed = state.tabs[0]
    await slice.sealLandedWorktree!(WT_A)

    expect(state.tabs[0]).toBe(sealed)
  })

  it('seals a conversation that arrives in an already-sealed worktree', async () => {
    const { state, slice } = harness({
      tabs: [{ id: 'tab-1', workingDirectory: WT_A, worktree: { landedAt: null } }],
    })
    await slice.sealLandedWorktree!(WT_A)

    // A second conversation opened elsewhere and relocated in must still get
    // sealed — idempotence must not degrade into "seal once per worktree".
    state.tabs = [...state.tabs, {
      id: 'tab-2', workingDirectory: WT_A, worktree: { landedAt: null },
      title: 'New Tab', customTitle: null, status: 'idle',
    }]
    await slice.sealLandedWorktree!(WT_A)

    expect(ion.engineStop).toHaveBeenCalledTimes(2)
    expect(ion.engineStop).toHaveBeenLastCalledWith('tab-2')
    expect(state.tabs[1].inputLocked).toBe(true)
  })
})

describe('repeated refresh over a landed worktree', () => {
  // The end-to-end shape of the production loop, driven the way the Inbox
  // effect drove it: refresh, refresh, refresh, with git unchanged throughout.
  it('converges — no store churn and no repeated engine traffic', async () => {
    ion.gitWorktreeInventory.mockResolvedValue({
      worktrees: [entry({ landedAt: 1_700_000_000_000 })],
    })
    const { state, slice } = harness({
      tabs: [{ id: 'tab-1', workingDirectory: WT_A, worktree: { landedAt: null } }],
    })

    await slice.refreshWorktreeInventory!(REPO)
    // The seal is fired without being awaited by the refresh (it is a void
    // branch there), so let its microtasks drain before sampling.
    await Promise.resolve()
    const inventoryAfterFirst = state.worktreeInventory.get(REPO)
    const tabsAfterFirst = state.tabs

    for (let pass = 0; pass < 5; pass++) {
      await slice.refreshWorktreeInventory!(REPO)
      await Promise.resolve()
    }

    expect(state.worktreeInventory.get(REPO)).toBe(inventoryAfterFirst)
    expect(state.tabs).toBe(tabsAfterFirst)
    expect(ion.engineStop).toHaveBeenCalledTimes(1)
  })
})
