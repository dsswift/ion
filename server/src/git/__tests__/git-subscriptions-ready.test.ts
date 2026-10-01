/**
 * A subscribe must hand back the repository's snapshot, never "no snapshot
 * yet". The first read of a fresh repository otherwise lands only as deltas,
 * which carry no `isGitRepo`, and Studio hid the Git dock tab for a
 * conversation opened in a brand-new worktree.
 */

import { vi, describe, it, expect, afterEach } from 'vitest'

vi.mock('../git-runner', () => ({ runGit: vi.fn(async () => '') }))
vi.mock('../../persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal()), ...{
  readGitWatcherIgnoredDirectories: vi.fn().mockReturnValue([]),
} }))
vi.mock('../watcher', () => ({
  createGitWatcher: () => ({ active: false, start: vi.fn(), stop: vi.fn(), setSuspended: vi.fn() }),
}))

import { GitRepository } from '../repository'
import { subscribeGit, unsubscribeGitAll } from '../git-subscriptions'
import type { GitEvent } from '@ion/shared/types-git-events'

describe('subscribeGit', () => {
  afterEach(() => { unsubscribeGitAll('conn-ready') })

  it('resolves with the first snapshot of a repository nobody had retained', async () => {
    const events: GitEvent[] = []
    const snapshot = await subscribeGit({ id: 'conn-ready', send: (e) => events.push(e) }, '/tmp/fresh-worktree')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.isGitRepo).toBe(true)
    expect(snapshot?.repoPath).toBe('/tmp/fresh-worktree')
  })

  it('resolves with the snapshot on a repeat subscribe that lands before the first read finishes', async () => {
    const sub = { id: 'conn-ready', send: () => {} }
    const [first, second] = await Promise.all([
      subscribeGit(sub, '/tmp/fresh-worktree-2'),
      subscribeGit(sub, '/tmp/fresh-worktree-2'),
    ])
    expect(first?.isGitRepo).toBe(true)
    expect(second?.isGitRepo).toBe(true)
  })
})

describe('GitRepository.refreshSnapshot', () => {
  it('a refresh requested while one runs resolves only once a snapshot exists', async () => {
    const repo = new GitRepository('/tmp/refresh-in-flight')
    const running = repo.refreshSnapshot()
    repo.retain()
    await repo.waitForReady()
    expect(repo.snapshot).not.toBeNull()
    await running
    repo.release()
  })
})
