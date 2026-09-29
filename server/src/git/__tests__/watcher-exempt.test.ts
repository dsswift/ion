/**
 * Pins the git-watcher exemption resolver.
 *
 * The failure it prevents: `~/.ion` is ignored by default (it holds
 * conversation NDJSON and rotating logs), and Ion stores real source checkouts
 * under it, so every worktree and bench ran with its file watcher suppressed —
 * the Diff panel and git Changes list received no events and refreshed only on
 * window focus.
 *
 * These assertions are about WHERE the exemptions come from: the durable
 * records, never a path-shape guess, and never at the cost of failing to
 * retain a repository when a record is unreadable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../worktree/registry', () => ({ registeredWorktreePaths: vi.fn(() => []) }))
vi.mock('../../integration/bench-store', () => ({ loadWorkspaces: vi.fn(() => []) }))

import { registeredWorktreePaths } from '../../worktree/registry'
import { loadWorkspaces } from '../../integration/bench-store'
import { watchedCheckoutPaths } from '../watcher-exempt'

const worktreesMock = vi.mocked(registeredWorktreePaths)
const workspacesMock = vi.mocked(loadWorkspaces)

beforeEach(() => {
  vi.clearAllMocks()
  worktreesMock.mockReturnValue([])
  workspacesMock.mockReturnValue([])
})

describe('watchedCheckoutPaths', () => {
  it('exempts every registered worktree and every bench', () => {
    worktreesMock.mockReturnValue(['/home/.ion/worktrees/a', '/home/.ion/worktrees/b'])
    workspacesMock.mockReturnValue([
      { benchPath: '/home/.ion/integration/repo-main' },
    ] as unknown as ReturnType<typeof loadWorkspaces>)

    expect(watchedCheckoutPaths()).toEqual([
      '/home/.ion/worktrees/a',
      '/home/.ion/worktrees/b',
      '/home/.ion/integration/repo-main',
    ])
  })

  // A worktree that has been relocated outside `~/.ion` needs no special case:
  // the records define the checkout, so it is exempt wherever it lives (and the
  // exemption is simply inert when nothing ignores that path).
  it('reports a checkout wherever it lives, not by path shape', () => {
    worktreesMock.mockReturnValue(['/tmp/relocated-worktree'])
    expect(watchedCheckoutPaths()).toContain('/tmp/relocated-worktree')
  })

  // Degrading matters more than completeness here: this runs inside repository
  // retain, and throwing would stop the git panel opening at all. The cost of
  // degrading is the old behaviour for that one surface.
  it('degrades to the bench list when the registry is unreadable', () => {
    worktreesMock.mockImplementation(() => { throw new Error('registry corrupt') })
    workspacesMock.mockReturnValue([
      { benchPath: '/home/.ion/integration/repo-main' },
    ] as unknown as ReturnType<typeof loadWorkspaces>)

    expect(watchedCheckoutPaths()).toEqual(['/home/.ion/integration/repo-main'])
  })

  it('degrades to the worktree list when bench records are unreadable', () => {
    worktreesMock.mockReturnValue(['/home/.ion/worktrees/a'])
    workspacesMock.mockImplementation(() => { throw new Error('workspaces corrupt') })

    expect(watchedCheckoutPaths()).toEqual(['/home/.ion/worktrees/a'])
  })

  it('returns nothing rather than throwing when both records fail', () => {
    worktreesMock.mockImplementation(() => { throw new Error('registry corrupt') })
    workspacesMock.mockImplementation(() => { throw new Error('workspaces corrupt') })

    expect(watchedCheckoutPaths()).toEqual([])
  })

  it('skips a workspace with no bench path', () => {
    workspacesMock.mockReturnValue([
      { benchPath: '' },
      { benchPath: '/home/.ion/integration/repo-main' },
    ] as unknown as ReturnType<typeof loadWorkspaces>)

    expect(watchedCheckoutPaths()).toEqual(['/home/.ion/integration/repo-main'])
  })
})
