/**
 * Worktree registry — work-stage record semantics.
 *
 * The stage is registry-scoped (not bench-scoped) so it exists before
 * enrollment and survives everything short of retirement. These tests pin the
 * write/clear/upsert paths and the one automatic transition (`bug` → `test` on
 * a pin advance), which `advanceWorktreeStageOnPinChange` applies from the
 * bench's update verbs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

let storeDir: string
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  // Per-file env var: vitest runs test FILES concurrently in one process, so a
  // shared name would let files clobber each other's fake home.
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_INVENTORY_STAGE || actual.homedir() }
})

import {
  registerWorktree, setWorktreeStage, lookupWorktreeStage,
  advanceWorktreeStageOnPinChange, worktreeRegistryFile,
} from '../registry'

const WT = '/wt/project-aaa'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-inventory-stage-'))
  storeDir = join(root, 'home')
  mkdirSync(join(storeDir, '.ion'), { recursive: true })
  process.env.ION_TEST_HOME_INVENTORY_STAGE = storeDir
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_INVENTORY_STAGE
  rmSync(root, { recursive: true, force: true })
})

function register(): void {
  registerWorktree({
    worktreePath: WT,
    repoPath: '/repo/project',
    branchName: 'wt/project-aaa',
    sourceBranch: 'main',
  })
}

describe('setWorktreeStage', () => {
  it('sets, replaces, and clears a stage on a registered worktree', () => {
    register()

    setWorktreeStage(WT, 'plan')
    expect(lookupWorktreeStage(WT)).toBe('plan')

    setWorktreeStage(WT, 'ready')
    expect(lookupWorktreeStage(WT)).toBe('ready')

    setWorktreeStage(WT, null)
    expect(lookupWorktreeStage(WT)).toBeNull()
  })

  it('persists the stage to disk, not just in memory', () => {
    register()
    setWorktreeStage(WT, 'test')

    const raw = JSON.parse(readFileSync(worktreeRegistryFile(), 'utf-8')) as {
      entries: Array<{ worktreePath: string; stage?: string }>
    }
    expect(raw.entries.find((e) => e.worktreePath === WT)?.stage).toBe('test')
  })

  it('creates a registry entry with an unknown source for an unregistered worktree', () => {
    // Same upsert rule as setWorktreeTitle: a hand-created worktree deserves a
    // marker, and the entry must record NULL rather than a guessed source
    // branch — a wrong one would make land merge into the wrong place.
    setWorktreeStage('/wt/hand-made', 'build', { repoPath: '/repo/project' })

    expect(lookupWorktreeStage('/wt/hand-made')).toBe('build')
    const raw = JSON.parse(readFileSync(worktreeRegistryFile(), 'utf-8')) as {
      entries: Array<{ worktreePath: string; sourceBranch: string | null }>
    }
    expect(raw.entries.find((e) => e.worktreePath === '/wt/hand-made')?.sourceBranch).toBeNull()
  })

  it('clearing a stage on an unregistered worktree creates nothing', () => {
    setWorktreeStage('/wt/nowhere', null)
    // The no-op path never saves, so the registry file itself is never
    // created — stronger than an empty entries list.
    expect(existsSync(worktreeRegistryFile())).toBe(false)
    expect(lookupWorktreeStage('/wt/nowhere')).toBeNull()
  })

  it('survives a re-registration, like title and landedAt', () => {
    register()
    setWorktreeStage(WT, 'merge')

    // Re-attach at the same path: the operator's marker is still where they
    // left it.
    register()

    expect(lookupWorktreeStage(WT)).toBe('merge')
  })
})

describe('advanceWorktreeStageOnPinChange', () => {
  it('moves bug to test', () => {
    register()
    setWorktreeStage(WT, 'bug')

    advanceWorktreeStageOnPinChange(WT)

    expect(lookupWorktreeStage(WT)).toBe('test')
  })

  it('leaves every other stage where the operator put it', () => {
    // Only `bug` declares an onPinAdvance in WORK_STAGES; the rest are
    // statements the pin cannot invalidate (`verified` describes the feature).
    for (const stage of ['plan', 'build', 'test', 'verified', 'merge', 'ready'] as const) {
      register()
      setWorktreeStage(WT, stage)
      advanceWorktreeStageOnPinChange(WT)
      expect(lookupWorktreeStage(WT)).toBe(stage)
    }
  })

  it('is a no-op on an unstaged or unregistered worktree', () => {
    register()
    advanceWorktreeStageOnPinChange(WT)
    expect(lookupWorktreeStage(WT)).toBeNull()

    // Unregistered: must not create an entry.
    advanceWorktreeStageOnPinChange('/wt/nowhere')
    expect(lookupWorktreeStage('/wt/nowhere')).toBeNull()
  })
})

describe('lookupWorktreeStage', () => {
  it('degrades an unknown persisted value to null rather than leaking it', () => {
    register()
    // Hand-edit the file with a value no build ever wrote.
    const file = worktreeRegistryFile()
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      entries: Array<Record<string, unknown>>
    }
    raw.entries[0].stage = 'shipping-it'
    writeFileSync(file, JSON.stringify(raw))

    expect(lookupWorktreeStage(WT)).toBeNull()
  })
})
