/**
 * worktree-set-stage-handler — remote set-stage path validation and persist.
 *
 * The property under test: handleWorktreeCommand('desktop_worktree_set_stage')
 * rejects relative paths, paths with newline/CR/NUL, and unknown stage values
 * with an error result and no registry mutation; valid inputs succeed; persist
 * failure is reported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sentResults: Array<{ type: string; operation?: string; ok: boolean; error?: string }> = []

vi.mock('../state', () => ({
  state: {
    remoteTransport: {
      send: (msg: Record<string, unknown>) => { sentResults.push(msg as typeof sentResults[0]) },
    },
  },
}))

vi.mock('../broadcast', () => ({
  broadcast: vi.fn(),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_SET_STAGE || actual.homedir() }
})

vi.mock('../worktree/inventory-service', () => ({
  getWorktreeInventory: vi.fn().mockResolvedValue([]),
}))

vi.mock('../worktree/integrate', () => ({
  syncWorktreeFromSource: vi.fn(),
  landWorktree: vi.fn(),
}))

vi.mock('../worktree/sync-all', () => ({
  syncAllWorktrees: vi.fn(),
}))

vi.mock('../integration/bench-ops', () => ({
  listWorkspaces: vi.fn().mockReturnValue([]),
  assembleWorkspace: vi.fn(),
  updateMember: vi.fn(),
  updateAllStale: vi.fn(),
  setMemberEnabled: vi.fn(),
  setMemberOrder: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  refreshStaleness: vi.fn(),
  sourceBranchTip: vi.fn(),
}))

vi.mock('../worktree/worktree-open', () => ({
  collectDirConversations: vi.fn().mockReturnValue([]),
  pickBenchConversation: vi.fn(),
  pickDirTerminal: vi.fn(),
}))

import {
  registerWorktree,
  setRegistryWriter,
  resetRegistryWriter,
} from '../worktree/registry'

import { handleWorktreeCommand } from '../remote/handlers/worktree'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-setstage-'))
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_TEST_HOME_SET_STAGE = home
  sentResults.length = 0
  resetRegistryWriter()
})

afterEach(() => {
  resetRegistryWriter()
  rmSync(home, { recursive: true, force: true })
  delete process.env.ION_TEST_HOME_SET_STAGE
})

async function handleSetStage(overrides: Partial<{
  worktreePath: string
  repoPath: string
  stage: string | null
}>): Promise<boolean> {
  return handleWorktreeCommand({
    type: 'desktop_worktree_set_stage',
    worktreePath: overrides.worktreePath ?? '/wt/test',
    repoPath: overrides.repoPath ?? '/repo',
    stage: overrides.stage === undefined ? 'build' : overrides.stage,
  } as Parameters<typeof handleWorktreeCommand>[0])
}

describe('desktop_worktree_set_stage handler', () => {
  it('rejects relative worktreePath', async () => {
    await handleSetStage({ worktreePath: 'relative/path' })
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Invalid path.')
  })

  it('rejects worktreePath with newline', async () => {
    await handleSetStage({ worktreePath: '/wt/bad\npath' })
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Invalid path.')
  })

  it('rejects worktreePath with carriage return', async () => {
    await handleSetStage({ worktreePath: '/wt/bad\rpath' })
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Invalid path.')
  })

  it('rejects worktreePath with NUL byte', async () => {
    await handleSetStage({ worktreePath: '/wt/bad\0path' })
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Invalid path.')
  })

  it('rejects relative repoPath', async () => {
    await handleSetStage({ repoPath: 'relative/repo' })
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Invalid path.')
  })

  it('rejects unknown stage value', async () => {
    await handleSetStage({ stage: 'nonexistent' })
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Unknown work stage.')
  })

  it('accepts null stage (clear)', async () => {
    await handleSetStage({ stage: null })
    const errors = sentResults.filter((r) => r.ok === false)
    expect(errors).toHaveLength(0)
  })

  it('accepts valid stage and valid paths', async () => {
    await handleSetStage({})
    const errors = sentResults.filter((r) => r.ok === false)
    expect(errors).toHaveLength(0)
  })

  it('reports persist failure', async () => {
    registerWorktree({
      worktreePath: '/wt/test',
      repoPath: '/repo',
      branchName: 'feat',
      sourceBranch: 'main',
    })
    setRegistryWriter(() => { throw new Error('disk full') })

    await handleSetStage({})
    expect(sentResults).toHaveLength(1)
    expect(sentResults[0].ok).toBe(false)
    expect(sentResults[0].error).toBe('Could not save the registry.')
  })
})
