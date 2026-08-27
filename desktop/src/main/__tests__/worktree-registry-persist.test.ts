/**
 * worktree-registry-persist — every registry mutator returns a checked boolean
 * and preserves prior state on write failure.
 *
 * The property under test: saveRegistry is injectable (setRegistryWriter /
 * resetRegistryWriter), every mutator surfaces the boolean, and a failing
 * writer never corrupts the in-memory load path (the next loadRegistry sees
 * the pre-mutation state because the write never landed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_REG_PERSIST || actual.homedir() }
})

import {
  registerWorktree,
  markWorktreeLanded,
  setWorktreeTitle,
  setWorktreeStage,
  setWorktreeBase,
  unregisterWorktree,
  migrateWorktreeStageOnPinAdvance,
  lookupWorktreeTitle,
  lookupWorktreeLandedAt,
  lookupWorktreeStage,
  lookupWorktreeBase,
  lookupSourceBranch,
  setRegistryWriter,
  resetRegistryWriter,
} from '../worktree/registry'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-regpersist-'))
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_TEST_HOME_REG_PERSIST = home
  resetRegistryWriter()
})

afterEach(() => {
  resetRegistryWriter()
  rmSync(home, { recursive: true, force: true })
  delete process.env.ION_TEST_HOME_REG_PERSIST
})

const REG_ARGS = {
  worktreePath: '/wt/a',
  repoPath: '/repo',
  branchName: 'feat-a',
  sourceBranch: 'main',
} as const

describe('registerWorktree', () => {
  it('returns true on successful persist', () => {
    expect(registerWorktree({ ...REG_ARGS })).toBe(true)
  })

  it('returns false when the writer throws', () => {
    setRegistryWriter(() => { throw new Error('disk full') })
    expect(registerWorktree({ ...REG_ARGS })).toBe(false)
  })

  it('preserves existing title on re-registration', () => {
    registerWorktree({ ...REG_ARGS, title: 'original title' })
    registerWorktree({ ...REG_ARGS, title: 'new title' })
    expect(lookupWorktreeTitle('/wt/a')).toBe('original title')
  })
})

describe('markWorktreeLanded', () => {
  it('returns true and records landedAt', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/b' })
    expect(markWorktreeLanded('/wt/b')).toBe(true)
    expect(lookupWorktreeLandedAt('/wt/b')).toBeGreaterThan(0)
  })

  it('returns false when no registry entry exists', () => {
    expect(markWorktreeLanded('/wt/nonexistent')).toBe(false)
  })

  it('returns true (no-op) when already landed', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/c' })
    markWorktreeLanded('/wt/c')
    expect(markWorktreeLanded('/wt/c')).toBe(true)
  })

  it('returns false when writer throws, success after reset', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/d' })
    setRegistryWriter(() => { throw new Error('ENOSPC') })
    expect(markWorktreeLanded('/wt/d')).toBe(false)
    resetRegistryWriter()
    expect(markWorktreeLanded('/wt/d')).toBe(true)
  })
})

describe('setWorktreeTitle', () => {
  it('returns true and persists', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/e' })
    expect(setWorktreeTitle('/wt/e', 'my feature')).toBe(true)
    expect(lookupWorktreeTitle('/wt/e')).toBe('my feature')
  })

  it('upserts for an unknown worktree with sourceBranch: null', () => {
    expect(setWorktreeTitle('/wt/hand', 'hand-created')).toBe(true)
    expect(lookupWorktreeTitle('/wt/hand')).toBe('hand-created')
    expect(lookupSourceBranch('/wt/hand')).toBeNull()
  })

  it('returns false on write failure', () => {
    setRegistryWriter(() => { throw new Error('fail') })
    expect(setWorktreeTitle('/wt/f', 'title')).toBe(false)
  })
})

describe('setWorktreeStage', () => {
  it('returns true and persists', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/g' })
    expect(setWorktreeStage('/wt/g', 'build')).toBe(true)
    expect(lookupWorktreeStage('/wt/g')).toBe('build')
  })

  it('clearing null on a missing entry returns true early', () => {
    expect(setWorktreeStage('/wt/missing', null)).toBe(true)
  })

  it('upserts for an unknown worktree', () => {
    expect(setWorktreeStage('/wt/hand2', 'plan', { repoPath: '/repo' })).toBe(true)
    expect(lookupWorktreeStage('/wt/hand2')).toBe('plan')
  })

  it('returns false on write failure', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/h' })
    setRegistryWriter(() => { throw new Error('fail') })
    expect(setWorktreeStage('/wt/h', 'test')).toBe(false)
  })
})

describe('migrateWorktreeStageOnPinAdvance', () => {
  it('migrates legacy bug stage to test', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/i' })
    setWorktreeStage('/wt/i', 'bug')
    expect(migrateWorktreeStageOnPinAdvance('/wt/i')).toBe(true)
    expect(lookupWorktreeStage('/wt/i')).toBe('test')
  })

  it('keeps non-bug stages unchanged', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/j' })
    setWorktreeStage('/wt/j', 'build')
    expect(migrateWorktreeStageOnPinAdvance('/wt/j')).toBe(true)
    expect(lookupWorktreeStage('/wt/j')).toBe('build')
  })

  it('returns true when no entry or no stage', () => {
    expect(migrateWorktreeStageOnPinAdvance('/wt/none')).toBe(true)
  })
})

describe('unregisterWorktree', () => {
  it('returns true and removes the entry', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/k', title: 'doomed' })
    expect(unregisterWorktree('/wt/k')).toBe(true)
    expect(lookupWorktreeTitle('/wt/k')).toBeNull()
  })

  it('returns true when entry does not exist', () => {
    expect(unregisterWorktree('/wt/nope')).toBe(true)
  })

  it('returns false on write failure', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/l' })
    setRegistryWriter(() => { throw new Error('fail') })
    expect(unregisterWorktree('/wt/l')).toBe(false)
  })
})

describe('setWorktreeBase', () => {
  it('returns true and persists', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/m' })
    expect(setWorktreeBase('/wt/m', 'abc1234')).toBe(true)
    expect(lookupWorktreeBase('/wt/m')).toBe('abc1234')
  })

  it('returns false when no entry exists', () => {
    expect(setWorktreeBase('/wt/ghost', 'abc')).toBe(false)
  })

  it('returns false on write failure', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/n' })
    setRegistryWriter(() => { throw new Error('fail') })
    expect(setWorktreeBase('/wt/n', 'def5678')).toBe(false)
  })

  it('prior state preserved on failure', () => {
    registerWorktree({ ...REG_ARGS, worktreePath: '/wt/o', baseSha: 'original' })
    setRegistryWriter(() => { throw new Error('fail') })
    setWorktreeBase('/wt/o', 'changed')
    resetRegistryWriter()
    expect(lookupWorktreeBase('/wt/o')).toBe('original')
  })
})
