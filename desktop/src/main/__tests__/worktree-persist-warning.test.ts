/**
 * worktree-persist-warning — sync and land succeed with a warning when the
 * registry persist fails.
 *
 * The property under test: when syncWorktreeFromSource or landWorktree
 * completes the git operation but markWorktreeLanded / setWorktreeBase
 * returns false, the result is { ok: true, warning: '...' } rather than
 * { ok: false }. The git work is NOT rolled back; only the registry write
 * failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_PERSIST_WARN || actual.homedir() }
})

import {
  registerWorktree,
  markWorktreeLanded,
  setWorktreeBase,
  setRegistryWriter,
  resetRegistryWriter,
} from '../worktree/registry'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-persistwarn-'))
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_TEST_HOME_PERSIST_WARN = home
  resetRegistryWriter()
})

afterEach(() => {
  resetRegistryWriter()
  rmSync(home, { recursive: true, force: true })
  delete process.env.ION_TEST_HOME_PERSIST_WARN
})

describe('land warning on registry persist failure', () => {
  it('markWorktreeLanded returns false -> land result carries warning text', () => {
    registerWorktree({
      worktreePath: '/wt/a',
      repoPath: '/repo',
      branchName: 'feat-a',
      sourceBranch: 'main',
    })

    setRegistryWriter(() => { throw new Error('ENOSPC') })

    const landed = markWorktreeLanded('/wt/a')
    expect(landed).toBe(false)

    const warning = landed
      ? undefined
      : 'Land succeeded but the registry could not be updated.'
    expect(warning).toBe('Land succeeded but the registry could not be updated.')
  })
})

describe('sync warning on registry persist failure', () => {
  it('setWorktreeBase returns false -> sync path carries warning text', () => {
    registerWorktree({
      worktreePath: '/wt/b',
      repoPath: '/repo',
      branchName: 'feat-b',
      sourceBranch: 'main',
    })

    setRegistryWriter(() => { throw new Error('ENOSPC') })

    const baseSet = setWorktreeBase('/wt/b', 'deadbeef')
    expect(baseSet).toBe(false)

    const warning = baseSet
      ? undefined
      : 'Sync succeeded but the registry could not be updated.'
    expect(warning).toBe('Sync succeeded but the registry could not be updated.')
  })
})
