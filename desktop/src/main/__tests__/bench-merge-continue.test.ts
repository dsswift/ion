import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('fs/promises', () => ({
  readFile: vi.fn((path: string) => Promise.resolve(path.endsWith('MERGE_HEAD') ? 'target\n' : 'merge message\n')),
}))
vi.mock('../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../git/operation-state', () => ({ probeOperationState: vi.fn() }))
vi.mock('../integration/bench-verify', () => ({ runBenchVerify: vi.fn() }))
vi.mock('../integration/bench-resolution-validation', () => ({
  currentRererePaths: vi.fn(),
  forgetRererePaths: vi.fn(),
  validateBenchResolution: vi.fn(),
}))
vi.mock('../integration/bench-resolution-journal', () => ({ recordResolution: vi.fn() }))
vi.mock('../integration/bench-store', () => ({ loadWorkspaces: vi.fn(() => []) }))
vi.mock('../integration/bench-resolution-completion', () => ({ clearResolvedBenchConflict: vi.fn(() => true) }))

import { runGit } from '../git-runner'
import { probeOperationState } from '../git/operation-state'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from '../integration/bench-resolution-validation'
import { runBenchVerify } from '../integration/bench-verify'
import { recordResolution } from '../integration/bench-resolution-journal'
import { loadWorkspaces } from '../integration/bench-store'
import { clearResolvedBenchConflict } from '../integration/bench-resolution-completion'
import { continueBenchMerge } from '../integration/bench-merge-continue'

const mockedRunGit = vi.mocked(runGit)
const mockedProbe = vi.mocked(probeOperationState)
const mockedPaths = vi.mocked(currentRererePaths)
const mockedForget = vi.mocked(forgetRererePaths)
const mockedValidate = vi.mocked(validateBenchResolution)
const mockedVerify = vi.mocked(runBenchVerify)
const mockedRecord = vi.mocked(recordResolution)
const mockedWorkspaces = vi.mocked(loadWorkspaces)
const mockedClearResolvedBenchConflict = vi.mocked(clearResolvedBenchConflict)

function arrangeRecovery(postHeadFails: boolean): void {
  let headReads = 0
  mockedRunGit.mockImplementation((_directory, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      headReads++
      if (postHeadFails && headReads === 2) return Promise.reject(new Error('HEAD unavailable'))
      return Promise.resolve('old-head\n')
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2])
    if (args.includes('merge') && args.includes('--continue')) return Promise.resolve('')
    if (args[0] === 'merge' && args.includes('--no-ff')) return Promise.reject(new Error('conflict'))
    return Promise.resolve('')
  })
  mockedPaths.mockResolvedValue({ ok: true, paths: ['shared.txt'] })
  mockedForget.mockResolvedValue({ ok: true, forgottenPaths: ['shared.txt'] })
  mockedValidate
    .mockResolvedValueOnce({ ok: true, unmergedPaths: [] })
    .mockResolvedValue({ ok: false, unmergedPaths: ['shared.txt'] })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedVerify.mockResolvedValue({ ran: false, ok: true, output: '', command: '' })
  mockedWorkspaces.mockReturnValue([])
  mockedClearResolvedBenchConflict.mockReturnValue(true)
})

describe('continueBenchMerge postcondition recovery injection', () => {
  it('restores and forgets resolution when project verification fails', async () => {
    let headReads = 0
    mockedRunGit.mockImplementation((_directory, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headReads++
        return Promise.resolve(headReads === 1 ? 'old-head\n' : headReads === 2 ? 'new-head\n' : 'old-head\n')
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2])
      if (args[0] === 'merge' && args.includes('--no-ff')) return Promise.reject(new Error('conflict'))
      return Promise.resolve('')
    })
    mockedPaths.mockResolvedValue({ ok: true, paths: ['shared.txt'] })
    mockedForget.mockResolvedValue({ ok: true, forgottenPaths: ['shared.txt'] })
    mockedValidate
      .mockResolvedValueOnce({ ok: true, unmergedPaths: [] })
      .mockResolvedValue({ ok: false, unmergedPaths: ['shared.txt'] })
    mockedProbe
      .mockResolvedValueOnce({ conflictedPaths: [] })
      .mockResolvedValue({ state: 'merging', conflictedPaths: ['shared.txt'] })
    mockedVerify.mockResolvedValue({ ran: true, ok: false, output: 'syntax error', command: 'test-verify' })

    const result = await continueBenchMerge('/bench')

    expect(result.ok).toBe(false)
    expect(mockedVerify).toHaveBeenCalledWith('/bench', '/bench')
    expect(mockedForget).toHaveBeenCalledWith('/bench', ['shared.txt'])
    expect(mockedValidate).toHaveBeenLastCalledWith('/bench', 'postcommit-recovery-proof')
  })

  it('recovers exact unmerged path when operation-state probe fails', async () => {
    arrangeRecovery(false)
    mockedProbe
      .mockRejectedValueOnce(new Error('state unavailable'))
      .mockResolvedValue({ state: 'merging', conflictedPaths: ['shared.txt'] })

    const result = await continueBenchMerge('/bench')

    expect(result).toEqual({
      ok: false,
      error: 'Completed merge failed validation. Original conflict was restored as recoverable for correction.',
    })
    const operations = mockedRunGit.mock.calls.map(([, args]) => args.join(' '))
    expect(operations.filter((op) => op.startsWith('reset --hard old-head'))).toHaveLength(2)
    expect(mockedForget).toHaveBeenCalledWith('/bench', ['shared.txt'])
    expect(operations.lastIndexOf('reset --hard old-head'))
      .toBeLessThan(operations.lastIndexOf('merge --no-ff -m merge message target'))
  })

  it('recovers exact unmerged path when postcommit HEAD read fails', async () => {
    arrangeRecovery(true)
    mockedProbe
      .mockResolvedValueOnce({ conflictedPaths: [] })
      .mockResolvedValue({ state: 'merging', conflictedPaths: ['shared.txt'] })

    const result = await continueBenchMerge('/bench')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected recovery failure result')
    expect(result.error).toMatch(/conflict.*recoverable/i)
    expect(mockedForget).toHaveBeenCalledTimes(1)
    expect(mockedValidate).toHaveBeenLastCalledWith('/bench', 'postcommit-recovery-proof')
  })
})

/**
 * The journal records only PROVEN resolutions.
 *
 * Placement is the whole assertion set here. Everything upstream of the
 * verification gate is unproven, and every failure above it rolls the merge back
 * through `restoreConflict` — so an entry written earlier would describe history
 * that no longer exists, and a later reader would consult a decision that was
 * discarded. Move the `recordResolution` call above the gate and the
 * rolled-back cases below go red.
 */
describe('continueBenchMerge — resolution journal', () => {
  const bench = {
    repoPath: '/repo',
    sourceBranch: 'josh',
    benchPath: '/bench',
    benchBranch: 'ion/bench/josh',
    baseSha: 'base123',
    lastBuiltAt: 0,
    members: [
      {
        worktreePath: '/wt/a', branchName: 'wt/a', enabled: true,
        pin: 'current' as const, merge: 'merged' as const,
        pinnedSha: 'target', pinnedTreeHash: 't', pinnedBaseSha: 'base123', currentTreeHash: 't',
      },
      {
        worktreePath: '/wt/b', branchName: 'wt/b', enabled: true,
        pin: 'current' as const, merge: 'merged' as const,
        pinnedSha: 'other', pinnedTreeHash: 't2', pinnedBaseSha: 'base123', currentTreeHash: 't2',
      },
    ],
  }

  function arrangeSuccess(): void {
    let headReads = 0
    mockedRunGit.mockImplementation((_directory, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headReads++
        return Promise.resolve(headReads === 1 ? 'old-head\n' : 'new-head\n')
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2])
      // The other member's pinned range touches the resolved path.
      if (args[0] === 'diff' && args.includes('--name-only') && args.includes('other')) {
        return Promise.resolve('shared.txt\n')
      }
      return Promise.resolve('')
    })
    mockedPaths.mockResolvedValue({ ok: true, paths: ['shared.txt'] })
    mockedValidate.mockResolvedValue({ ok: true, unmergedPaths: [] })
    mockedProbe.mockResolvedValue({ conflictedPaths: [] })
  }

  it('records one entry per resolved path after a proven-good continue', async () => {
    mockedWorkspaces.mockReturnValue([bench] as never)
    arrangeSuccess()

    const result = await continueBenchMerge('/bench')

    expect(result.ok).toBe(true)
    expect(mockedRecord).toHaveBeenCalledTimes(1)
    expect(mockedRecord.mock.calls[0][0]).toMatchObject({
      repoPath: '/repo',
      sourceBranch: 'josh',
      path: 'shared.txt',
      // Attributed from MERGE_HEAD, not from "who last touched the file".
      memberBranch: 'wt/a',
      memberPinnedSha: 'target',
      resolvedSha: 'new-head',
    })
  })

  it('names the counterpart members whose pinned ranges touch the path', async () => {
    mockedWorkspaces.mockReturnValue([bench] as never)
    arrangeSuccess()

    await continueBenchMerge('/bench')

    expect(mockedRecord.mock.calls[0][0].collidedWith).toEqual(['wt/b'])
  })

  it('records NOTHING when project verification fails and the merge rolls back', async () => {
    mockedWorkspaces.mockReturnValue([bench] as never)
    let headReads = 0
    mockedRunGit.mockImplementation((_directory, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headReads++
        return Promise.resolve(headReads === 1 ? 'old-head\n' : headReads === 2 ? 'new-head\n' : 'old-head\n')
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2])
      if (args[0] === 'merge' && args.includes('--no-ff')) return Promise.reject(new Error('conflict'))
      return Promise.resolve('')
    })
    mockedPaths.mockResolvedValue({ ok: true, paths: ['shared.txt'] })
    mockedForget.mockResolvedValue({ ok: true, forgottenPaths: ['shared.txt'] })
    mockedValidate
      .mockResolvedValueOnce({ ok: true, unmergedPaths: [] })
      .mockResolvedValue({ ok: false, unmergedPaths: ['shared.txt'] })
    mockedProbe
      .mockResolvedValueOnce({ conflictedPaths: [] })
      .mockResolvedValue({ state: 'merging', conflictedPaths: ['shared.txt'] })
    mockedVerify.mockResolvedValue({ ran: true, ok: false, output: 'build failed', command: 'test-verify' })

    const result = await continueBenchMerge('/bench')

    expect(result.ok).toBe(false)
    expect(mockedRecord).not.toHaveBeenCalled()
  })

  it('records nothing when the directory is not a registered bench', async () => {
    mockedWorkspaces.mockReturnValue([])
    arrangeSuccess()

    const result = await continueBenchMerge('/bench')

    expect(result.ok).toBe(true)
    expect(mockedRecord).not.toHaveBeenCalled()
  })

  it('clears the exact MERGE_HEAD member only after proven continuation', async () => {
    mockedWorkspaces.mockReturnValue([bench] as never)
    arrangeSuccess()

    const result = await continueBenchMerge('/bench')

    expect(result).toEqual({ ok: true })
    expect(mockedClearResolvedBenchConflict).toHaveBeenCalledWith('/bench', 'target')
  })

  it('does not clear row verdict when continuation rolls back', async () => {
    mockedWorkspaces.mockReturnValue([bench] as never)
    let headReads = 0
    mockedRunGit.mockImplementation((_directory, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headReads++
        return Promise.resolve(headReads === 1 ? 'old-head\n' : headReads === 2 ? 'new-head\n' : 'old-head\n')
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return Promise.resolve(args[2])
      if (args[0] === 'merge' && args.includes('--no-ff')) return Promise.reject(new Error('conflict'))
      return Promise.resolve('')
    })
    mockedPaths.mockResolvedValue({ ok: true, paths: ['shared.txt'] })
    mockedForget.mockResolvedValue({ ok: true, forgottenPaths: ['shared.txt'] })
    mockedValidate
      .mockResolvedValueOnce({ ok: true, unmergedPaths: [] })
      .mockResolvedValue({ ok: false, unmergedPaths: ['shared.txt'] })
    mockedProbe
      .mockResolvedValueOnce({ conflictedPaths: [] })
      .mockResolvedValue({ state: 'merging', conflictedPaths: ['shared.txt'] })
    mockedVerify.mockResolvedValue({ ran: true, ok: false, output: 'build failed', command: 'test-verify' })

    const result = await continueBenchMerge('/bench')

    expect(result.ok).toBe(false)
    expect(mockedClearResolvedBenchConflict).not.toHaveBeenCalled()
  })

  it('marks the entry verified only when verification actually ran and passed', async () => {
    mockedWorkspaces.mockReturnValue([bench] as never)
    arrangeSuccess()
    mockedVerify.mockResolvedValue({ ran: false, ok: true, output: '', command: '' })

    await continueBenchMerge('/bench')

    // `ran: false` is "no project verification declared", which is NOT proof the
    // resolution builds — recording it as verified would overstate the evidence.
    expect(mockedRecord.mock.calls[0][0].verified).toBe(false)
  })
})
