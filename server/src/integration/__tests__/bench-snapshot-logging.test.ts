/**
 * contributedTreeHash runs on the worktree panel's poll. A read that repeats
 * what the member record already holds must not write an INFO or WARN line per
 * member per poll; a read that changes the record must.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IntegrationMember } from '@ion/shared/types'

const mockRunGit = vi.fn(async (..._a: unknown[]): Promise<string> => '')
vi.mock('../../git/git-runner', () => ({ runGit: (...a: unknown[]) => mockRunGit(...a) }))
const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('../../logger', () => logger)

import { contributedTreeHash } from '../bench-snapshot'

function member(overrides: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/a', branchName: 'wt/a', pin: 'current', merge: 'unbuilt',
    pinnedSha: 'aaa', pinnedTreeHash: 'tree-1', pinnedBaseSha: 'base', currentTreeHash: 'tree-1',
    ...overrides,
  }
}

beforeEach(() => {
  mockRunGit.mockReset()
  logger.log.mockClear()
  logger.warn.mockClear()
  logger.debug.mockClear()
})

describe('contributedTreeHash log levels', () => {
  it('logs an unchanged tree at DEBUG and a moved tree at INFO', async () => {
    mockRunGit.mockResolvedValue('tree-1\n')
    expect(await contributedTreeHash(member())).toBe('tree-1')
    expect(logger.log).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledTimes(1)

    mockRunGit.mockResolvedValue('tree-2\n')
    expect(await contributedTreeHash(member())).toBe('tree-2')
    expect(logger.log).toHaveBeenCalledTimes(1)
  })

  it('warns when a member first goes missing and stays at DEBUG once recorded gone', async () => {
    mockRunGit.mockRejectedValue(new Error('spawn git ENOENT'))
    expect(await contributedTreeHash(member())).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)

    expect(await contributedTreeHash(member({ pin: 'gone' }))).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledTimes(1)
  })
})
