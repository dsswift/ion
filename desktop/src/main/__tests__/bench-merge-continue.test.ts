import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('fs/promises', () => ({
  readFile: vi.fn((path: string) => Promise.resolve(path.endsWith('MERGE_HEAD') ? 'target\n' : 'merge message\n')),
}))
vi.mock('../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../git/operation-state', () => ({ probeOperationState: vi.fn() }))
vi.mock('../integration/bench-resolution-validation', () => ({
  currentRererePaths: vi.fn(),
  forgetRererePaths: vi.fn(),
  validateBenchResolution: vi.fn(),
}))

import { runGit } from '../git-runner'
import { probeOperationState } from '../git/operation-state'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from '../integration/bench-resolution-validation'
import { continueBenchMerge } from '../integration/bench-merge-continue'

const mockedRunGit = vi.mocked(runGit)
const mockedProbe = vi.mocked(probeOperationState)
const mockedPaths = vi.mocked(currentRererePaths)
const mockedForget = vi.mocked(forgetRererePaths)
const mockedValidate = vi.mocked(validateBenchResolution)

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
})

describe('continueBenchMerge postcondition recovery injection', () => {
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
