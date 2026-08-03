import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { rWarn } from '../../rendererLogger'
import { resolveRegisteredWorktree } from '../worktree-registration'
import type { WorktreeInfo } from '../../../shared/types'

const DIR = '/Users/example/.ion/worktrees/project-a3f1'
const EXISTING: WorktreeInfo = {
  worktreePath: DIR,
  branchName: 'wt/a3f1',
  sourceBranch: 'main',
  repoPath: '/Users/example/project',
}
const lookup = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as { window?: unknown }).window = {
    ion: { gitWorktreeRegistration: lookup },
  }
})

describe('resolveRegisteredWorktree', () => {
  it('keeps existing metadata without querying registry', async () => {
    await expect(resolveRegisteredWorktree(DIR, EXISTING)).resolves.toBe(EXISTING)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('constructs worktree identity from authoritative registration', async () => {
    lookup.mockResolvedValue({ registration: {
      repoPath: '/Users/example/project', branchName: 'wt/a3f1', sourceBranch: 'main', title: null,
    } })

    await expect(resolveRegisteredWorktree(DIR)).resolves.toEqual(EXISTING)
    expect(lookup).toHaveBeenCalledWith(DIR)
  })

  it('returns null for ordinary unregistered directory', async () => {
    lookup.mockResolvedValue({ registration: null })
    await expect(resolveRegisteredWorktree('/Users/example/project')).resolves.toBeNull()
  })

  it('refuses registration whose source branch is unknown', async () => {
    lookup.mockResolvedValue({ registration: {
      repoPath: '/Users/example/project', branchName: 'wt/a3f1', sourceBranch: null, title: null,
    } })

    await expect(resolveRegisteredWorktree(DIR)).resolves.toBeNull()
    expect(rWarn).toHaveBeenCalledWith(
      'worktree.registration',
      'registered worktree has no source branch',
      expect.objectContaining({ worktree_path: DIR }),
    )
  })

  it('logs lookup failure and leaves identity unset', async () => {
    lookup.mockRejectedValue(new Error('socket closed'))

    await expect(resolveRegisteredWorktree(DIR)).resolves.toBeNull()
    expect(rWarn).toHaveBeenCalledWith(
      'worktree.registration',
      'worktree registration lookup failed',
      expect.objectContaining({ worktree_path: DIR, error: 'Error: socket closed' }),
    )
  })
})
