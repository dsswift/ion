import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../git-runner', () => ({ runGit: vi.fn() }))

import { runGit } from '../git-runner'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from '../integration/bench-resolution-validation'

const mockedRunGit = vi.mocked(runGit)

beforeEach(() => {
  mockedRunGit.mockReset()
})

describe('bench resolution validation failures', () => {
  it('returns explicit failure when unmerged-path probe fails', async () => {
    mockedRunGit.mockRejectedValueOnce(new Error('probe unavailable'))

    const result = await validateBenchResolution('/bench', 'test')

    expect(result).toEqual({ ok: false, unmergedPaths: [], probeError: 'probe unavailable' })
  })

  it('returns explicit failure when rerere path capture fails', async () => {
    mockedRunGit.mockRejectedValueOnce(new Error('capture unavailable'))

    await expect(currentRererePaths('/bench')).resolves.toEqual({
      ok: false,
      error: 'capture unavailable',
    })
  })

  it('captures staged paths when fully autostaged replay empties rerere status', async () => {
    mockedRunGit
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('merge-head\n')
      .mockResolvedValueOnce('replayed.txt\n')

    await expect(currentRererePaths('/bench')).resolves.toEqual({
      ok: true,
      paths: ['replayed.txt'],
    })
  })

  it('fails capture when active merge staged-path probe fails', async () => {
    mockedRunGit
      .mockResolvedValueOnce('conflict.txt\n')
      .mockResolvedValueOnce('merge-head\n')
      .mockRejectedValueOnce(new Error('index unavailable'))

    const result = await currentRererePaths('/bench')
    expect(result.ok).toBe(false)
  })

  it('stops at first rerere forget failure and reports completed forgets', async () => {
    mockedRunGit
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('first.txt\n')
      .mockRejectedValueOnce(new Error('forget unavailable'))

    await expect(forgetRererePaths('/bench', ['first.txt', 'second.txt'])).resolves.toEqual({
      ok: false,
      error: 'forget unavailable',
      path: 'second.txt',
      forgottenPaths: ['first.txt'],
    })
    expect(mockedRunGit).toHaveBeenCalledTimes(3)
  })
})
