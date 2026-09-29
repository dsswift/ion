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

vi.mock('../../../state', async (importOriginal) => ({ ...(await importOriginal()), ...{
  state: {
    remoteWorktreeStates: new Map(),
  },
} }))

vi.mock('../../../thin-view/remote-out', () => ({
  remoteClientsPresent: () => true,
  sendRemoteEvent: (msg: Record<string, unknown>) => { sentResults.push(msg as typeof sentResults[0]) },
}))

vi.mock('../worktree-store-commands', () => ({
  handleWorktreeStoreCommand: vi.fn(async () => true),
}))
vi.mock('../../../broadcast', () => ({
  broadcast: vi.fn(),
}))



vi.mock('../../../worktree/inventory-service', () => ({
  getWorktreeInventory: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../worktree/integrate', () => ({
  syncWorktreeFromSource: vi.fn(),
  landAndRetireWorktree: vi.fn(),
}))

vi.mock('../../../worktree/sync-all', () => ({
  syncAllWorktrees: vi.fn(),
}))

vi.mock('../../../integration/bench-ops', () => ({
  listWorkspaces: vi.fn().mockReturnValue([]),
  assembleWorkspace: vi.fn(),
  updateMember: vi.fn(),
  updateAllStale: vi.fn(),
  setMemberOrder: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  refreshStaleness: vi.fn(),
  sourceBranchTip: vi.fn(),
}))

import {
  registerWorktree,
  setRegistryWriter,
  resetRegistryWriter,
} from '../../../worktree/registry'

import { handleWorktreeCommand } from '../worktree'
import { handleWorktreeStoreCommand } from '../worktree-store-commands'
import { landAndRetireWorktree } from '../../../worktree/integrate'
import { broadcast } from '../../../broadcast'

let home: string

let savedIonDataDir: string | undefined

beforeEach(() => {
  savedIonDataDir = process.env.ION_DATA_DIR
  home = mkdtempSync(join(tmpdir(), 'ion-setstage-'))
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_DATA_DIR = join(home, '.ion')
  sentResults.length = 0
  vi.clearAllMocks()
  resetRegistryWriter()
})

afterEach(() => {
  resetRegistryWriter()
  rmSync(home, { recursive: true, force: true })
  if (savedIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = savedIonDataDir
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

describe('desktop_worktree remote lifecycle', () => {
  it('delegates every store-backed verb to the store-command module, which answers the phone itself', async () => {
    // Validation and the op results for these are pinned in
    // server/src/remote/handlers/__tests__/worktree-store-commands.test.ts.
    const commands = [
      { type: 'desktop_worktree_create', repoPath: '/repo', sourceBranch: 'main' },
      { type: 'desktop_worktree_convert_conversation', tabId: 'tab-1' },
      { type: 'desktop_worktree_rename', repoPath: '/repo', worktreePath: '/wt/a', title: 'Work' },
      { type: 'desktop_worktree_reprovision', repoPath: '/repo', worktreePath: '/wt/a' },
      { type: 'desktop_bench_recover_conflict', repoPath: '/repo', sourceBranch: 'main' },
      { type: 'desktop_bench_analyse_verification', repoPath: '/repo', sourceBranch: 'main' },
      { type: 'desktop_bench_discard_member_recordings', repoPath: '/repo', sourceBranch: 'main', branchNames: ['wt/a'] },
      { type: 'desktop_bench_discard_all_recordings', repoPath: '/repo', sourceBranch: 'main' },
    ] as const

    for (const command of commands) {
      expect(await handleWorktreeCommand(command as Parameters<typeof handleWorktreeCommand>[0])).toBe(true)
      expect(handleWorktreeStoreCommand).toHaveBeenLastCalledWith(command)
    }
    // Nothing rides a broadcast any more: the channels those used to take
    // had no listener once the store moved into the server.
    expect(broadcast).not.toHaveBeenCalledWith(expect.stringMatching(/^ion:remote-/), expect.anything())
  })

  it('broadcasts sealed worktree after remote land succeeds', async () => {
    vi.mocked(landAndRetireWorktree).mockResolvedValue({ ok: true, landed: true, mode: 'merge', sha: 'abc' })

    await handleWorktreeCommand({
      type: 'desktop_worktree_land_and_retire', repoPath: '/repo', worktreePath: '/wt/landed',
      worktreeBranch: 'wt/landed', sourceBranch: 'main',
    } as Parameters<typeof handleWorktreeCommand>[0])

    expect(broadcast).toHaveBeenCalledWith('ion:worktree-landed', {
      repoPath: '/repo', worktreePath: '/wt/landed', prunedBenchPaths: [],
    })
  })

  it('refuses opening a landed worktree and refreshes its state', async () => {
    registerWorktree({
      repoPath: '/repo', worktreePath: '/wt/landed', branchName: 'wt/landed', sourceBranch: 'main',
    })
    // Preserve terminal landed fact, as real land operation does.
    const registry = await import('../../../worktree/registry')
    const mark = registry.markWorktreeLanded('/wt/landed')
    expect(mark).toBe(true)

    await handleWorktreeCommand({
      type: 'desktop_worktree_open_conversation', worktreePath: '/wt/landed', newConversation: false,
    } as Parameters<typeof handleWorktreeCommand>[0])

    expect(sentResults).toContainEqual(expect.objectContaining({
      type: 'desktop_worktree_op_result', operation: 'open', ok: false,
      error: 'This worktree has landed and is sealed for review.',
    }))
    expect(sentResults).toContainEqual(expect.objectContaining({ type: 'desktop_worktree_state' }))
  })
})
