/**
 * A landed worktree that is still on disk settles its conversations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => ({}) } }))
vi.mock('../rendererLogger', () => ({ rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn() }))

import { harness, ion, resetIon, WT_A } from './helpers/worktree-inventory-harness'

vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  gitWorktreeInventory: (...args: any[]) => ion.gitWorktreeInventory(...args),
  gitWorktreeSync: (...args: any[]) => ion.gitWorktreeSync(...args),
  gitWorktreeRegistration: (...args: any[]) => ion.gitWorktreeRegistration(...args),
  gitWorktreeLandAndRetire: (...args: any[]) => ion.gitWorktreeLandAndRetire(...args),
  gitWorktreeDiscard: (...args: any[]) => ion.gitWorktreeDiscard(...args),
  gitWorktreeRetirePreview: (...args: any[]) => ion.gitWorktreeRetirePreview(...args),
  relocateTabSession: (...args: any[]) => ion.relocateTabSession(...args),
  engineStop: (...args: any[]) => ion.engineStop(...args),
}))

beforeEach(resetIon)

function landed() {
  const h = harness({ tabs: [
    { id: 'tab-1', workingDirectory: WT_A, worktree: { landedAt: null } },
    { id: 'term', workingDirectory: WT_A, isTerminalOnly: true },
  ] })
  return { ...h, settleLandedTab: h.state.settleLandedTab }
}

describe('settle on land', () => {
  it('settles each conversation of the landed worktree once', async () => {
    const { slice, settleLandedTab } = landed()
    await slice.sealLandedWorktree!(WT_A)
    await slice.sealLandedWorktree!(WT_A)
    expect(settleLandedTab).toHaveBeenCalledTimes(1)
    expect(settleLandedTab).toHaveBeenCalledWith('tab-1')
  })
})
