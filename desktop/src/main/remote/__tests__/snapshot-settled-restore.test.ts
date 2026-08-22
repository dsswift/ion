import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

const tabsFile = vi.hoisted(() => '/tmp/ion-settled-snapshot-tabs.json')
const worktreePath = '/tmp/ion-settled-snapshot-worktree'

vi.mock('../../settings-store', () => ({ TABS_FILE: tabsFile }))
vi.mock('../../machine-identity', () => ({ getMachineIdentity: () => null }))
vi.mock('../../logger', () => ({ warn: vi.fn() }))
vi.mock('../../worktree/inventory', () => ({ lookupWorktreeRegistration: vi.fn() }))

import { lookupWorktreeRegistration } from '../../worktree/inventory'
import { settledTabsSnapshot } from '../snapshot-settled'

const lookup = vi.mocked(lookupWorktreeRegistration)

function writeSettled(worktreePath?: string, tabRole?: string): void {
  writeFileSync(tabsFile, JSON.stringify({ settledHistory: [{
    id: 'settled', title: 'Review', workingDirectory: worktreePath ?? '/repo', settledAt: 10,
    ...(tabRole ? { tabRole } : {}),
    ...(worktreePath ? { worktree: { worktreePath, repoPath: '/repo', branchName: 'wt/test', sourceBranch: 'main' } } : {}),
  }] }))
}

describe('settled tab snapshot restore capability', () => {
  beforeEach(() => lookup.mockReset())
  afterEach(() => {
    rmSync(tabsFile, { force: true })
    rmSync(worktreePath, { force: true, recursive: true })
  })

  it('keeps plain settled records restorable', () => {
    writeSettled()
    expect(settledTabsSnapshot()[0]?.canRestoreSettled).toBe(true)
  })

  it('marks a retired-worktree record as permanent history', () => {
    writeSettled(worktreePath)
    lookup.mockReturnValue(null)
    expect(settledTabsSnapshot()[0]?.canRestoreSettled).toBe(false)
  })

  it('marks a missing registered worktree as permanent history', () => {
    writeSettled(worktreePath)
    lookup.mockReturnValue({ repoPath: '/repo', branchName: 'wt/test', sourceBranch: 'main', title: null })
    expect(settledTabsSnapshot()[0]?.canRestoreSettled).toBe(false)
  })

  it('keeps a registered worktree record restorable', () => {
    mkdirSync(worktreePath, { recursive: true })
    writeSettled(worktreePath)
    lookup.mockReturnValue({ repoPath: '/repo', branchName: 'wt/test', sourceBranch: 'main', title: null })
    expect(settledTabsSnapshot()[0]?.canRestoreSettled).toBe(true)
  })
})

/**
 * An ephemeral role settles permanently, and the snapshot must SAY so: iOS
 * reads an absent `canRestoreSettled` as restorable, so silence here would put
 * an Un-settle button on a record that cannot come back.
 */
describe('settled snapshot permanence by role', () => {
  afterEach(() => {
    rmSync(tabsFile, { force: true })
    rmSync(worktreePath, { force: true, recursive: true })
  })

  for (const role of ['bench-conversation', 'conflict-auto-fix', 'verification-analysis']) {
    it(`marks a settled ${role} as permanent history`, () => {
      writeSettled(undefined, role)
      const record = settledTabsSnapshot()[0]
      expect(record?.canRestoreSettled).toBe(false)
      expect(record?.tabRole).toBe(role)
    })
  }

  it('stays permanent for a bench conversation whose worktree is present', () => {
    // The filesystem answer is irrelevant: the bench branch is rebuilt from
    // its members' pins regardless of the checkout existing right now.
    mkdirSync(worktreePath, { recursive: true })
    writeSettled(worktreePath, 'bench-conversation')
    lookup.mockReturnValue({ repoPath: '/repo', branchName: 'wt/test', sourceBranch: 'main', title: null })
    expect(settledTabsSnapshot()[0]?.canRestoreSettled).toBe(false)
  })
})
