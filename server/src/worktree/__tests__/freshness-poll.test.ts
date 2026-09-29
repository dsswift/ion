/**
 * Pins the freshness poll's contract.
 *
 * The bug this exists to prevent is not subtle: the worktree surfaces had NO
 * periodic refresh at all after the panel that owned the old 5s timer was
 * deleted, so a row's dirty marker, unlanded count, and bench pin verdict froze
 * for as long as the session lasted (22 minutes with zero crawls, observed,
 * while the git watcher for the same repo logged over a thousand events).
 *
 * So the assertions here are about the poll actually doing its job: it finds
 * repos with no client telling it what to look at, it crawls each one once,
 * it refreshes this server's own store, and it does none of that when nothing
 * is watching.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { WorktreeInventoryEntry } from '@ion/shared/types'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
const refreshWorkspaceViews = vi.fn(async (_repoPath: string) => {})
vi.mock('../../store/sessionStore', () => ({ useSessionStore: { getState: () => ({ refreshWorkspaceViews }) } }))
vi.mock('../registry', () => ({ registeredRepoPaths: vi.fn(() => []) }))
vi.mock('../inventory-service', () => ({ getWorktreeInventory: vi.fn(async () => []) }))
vi.mock('../../integration/bench-store', () => ({ loadWorkspaces: vi.fn(() => []) }))
vi.mock('../../remote/handlers/worktree', () => ({ pushWorktreeState: vi.fn(async () => {}) }))
// The projection is gated on a connected thin client; drive that gate
// directly rather than registering a real connection per arm.
vi.mock('../../thin-view/remote-out', () => ({ remoteClientsPresent: vi.fn(() => false) }))

import { focusState } from '../../git/focus-state'
import { registeredRepoPaths } from '../registry'
import { getWorktreeInventory } from '../inventory-service'
import { loadWorkspaces } from '../../integration/bench-store'
import { pushWorktreeState } from '../../remote/handlers/worktree'
import { remoteClientsPresent } from '../../thin-view/remote-out'
import { _resetInventoryCacheForTests, storeInventory } from '../inventory-cache'
import {
  FRESHNESS_POLL_MS,
  pollWorktreeFreshnessOnce,
  startWorktreeFreshnessPoll,
  stopWorktreeFreshnessPoll,
} from '../freshness-poll'

const reposMock = vi.mocked(registeredRepoPaths)
const crawlMock = vi.mocked(getWorktreeInventory)
const workspacesMock = vi.mocked(loadWorkspaces)
const pushMock = vi.mocked(pushWorktreeState)
const clientsPresentMock = vi.mocked(remoteClientsPresent)

beforeEach(() => {
  _resetInventoryCacheForTests()
  vi.clearAllMocks()
  reposMock.mockReturnValue([])
  workspacesMock.mockReturnValue([])
  crawlMock.mockResolvedValue([])
  clientsPresentMock.mockReturnValue(false)
  focusState.setFocused(true)
})

afterEach(() => {
  stopWorktreeFreshnessPoll()
  vi.useRealTimers()
})

describe('pollWorktreeFreshnessOnce', () => {
  it('crawls every repo the registry knows about, with no renderer involved', async () => {
    reposMock.mockReturnValue(['/repo-a', '/repo-b'])
    await pollWorktreeFreshnessOnce()
    expect(crawlMock).toHaveBeenCalledWith('/repo-a')
    expect(crawlMock).toHaveBeenCalledWith('/repo-b')
    expect(crawlMock).toHaveBeenCalledTimes(2)
  })

  // A bench outlives its members: every worktree can be retired while the bench
  // record remains, and its assembly age and staleness still need refreshing.
  it('includes repos that have a bench but no registered worktree', async () => {
    reposMock.mockReturnValue([])
    workspacesMock.mockReturnValue([
      { repoPath: '/bench-only', sourceBranch: 'main', benchPath: '/b', benchBranch: 'ion/bench/main', members: [], baseSha: '', lastBuiltAt: 0 },
    ] as unknown as ReturnType<typeof loadWorkspaces>)
    await pollWorktreeFreshnessOnce()
    expect(crawlMock).toHaveBeenCalledWith('/bench-only')
  })

  // Every checkout of a repo answers `git worktree list` identically, so a repo
  // reachable as both its main clone and a worktree path is ONE crawl.
  it('collapses alias paths of one repo into a single crawl', async () => {
    storeInventory('/repo-a', ['/repo-a', '/repo-a/wt-1'], [])
    reposMock.mockReturnValue(['/repo-a', '/repo-a/wt-1'])
    await pollWorktreeFreshnessOnce()
    expect(crawlMock).toHaveBeenCalledTimes(1)
    expect(crawlMock).toHaveBeenCalledWith('/repo-a')
  })

  // The server owns the store every client renders. A remote server's tick
  // must refresh THAT store: a client asked to refresh on the server's behalf
  // routes the call to its own local server instead.
  it('refreshes this server\'s own store for every repo it crawled', async () => {
    reposMock.mockReturnValue(['/repo-a', '/repo-b'])
    await pollWorktreeFreshnessOnce()
    expect(refreshWorkspaceViews.mock.calls).toEqual([['/repo-a'], ['/repo-b']])
  })

  it('keeps refreshing the rest when one store refresh throws', async () => {
    reposMock.mockReturnValue(['/repo-a', '/repo-b'])
    refreshWorkspaceViews.mockRejectedValueOnce(new Error('boom'))
    await pollWorktreeFreshnessOnce()
    expect(refreshWorkspaceViews).toHaveBeenCalledWith('/repo-b')
  })

  it('does not build the client projection when no client is connected', async () => {
    reposMock.mockReturnValue(['/repo-a'])
    await pollWorktreeFreshnessOnce()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('pushes worktree state to a connected client', async () => {
    reposMock.mockReturnValue(['/repo-a'])
    clientsPresentMock.mockReturnValue(true)
    await pollWorktreeFreshnessOnce()
    expect(pushMock).toHaveBeenCalledWith('/repo-a')
  })

  // One unreadable repo (deleted directory, git failure) must not cost the
  // others their refresh — that would turn a single bad worktree into a
  // silently frozen panel for every other project.
  it('continues past a failing repo and still refreshes', async () => {
    reposMock.mockReturnValue(['/bad', '/good'])
    crawlMock.mockRejectedValueOnce(new Error('not a repository'))
    await pollWorktreeFreshnessOnce()
    expect(crawlMock).toHaveBeenCalledWith('/good')
    expect(refreshWorkspaceViews.mock.calls).toEqual([['/bad'], ['/good']])
  })

  it('does nothing when there are no repos', async () => {
    await pollWorktreeFreshnessOnce()
    expect(crawlMock).not.toHaveBeenCalled()
    expect(refreshWorkspaceViews).not.toHaveBeenCalled()
  })
})

describe('startWorktreeFreshnessPoll', () => {
  it('ticks on the interval', async () => {
    vi.useFakeTimers()
    reposMock.mockReturnValue(['/repo-a'])
    startWorktreeFreshnessPoll()
    expect(crawlMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS)
    expect(crawlMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS)
    expect(crawlMock).toHaveBeenCalledTimes(2)
  })

  // Attention is a focused window OR a connected phone. With neither, the
  // desktop must do no git work at all — this timer runs forever otherwise.
  it('skips the tick when nothing is watching', async () => {
    vi.useFakeTimers()
    reposMock.mockReturnValue(['/repo-a'])
    focusState.setFocused(false)
    startWorktreeFreshnessPoll()
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS * 3)
    expect(crawlMock).not.toHaveBeenCalled()

    focusState.setFocused(true)
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS)
    expect(crawlMock).toHaveBeenCalledTimes(1)
  })

  // A crawl slower than the period must not stack: queued ticks are how the
  // original overlapping-crawl spawn storm built up.
  it('does not overlap a slow tick with the next one', async () => {
    vi.useFakeTimers()
    reposMock.mockReturnValue(['/repo-a'])
    let complete: () => void = () => { throw new Error('slow crawl completion was not initialized') }
    crawlMock.mockImplementationOnce(() => new Promise<WorktreeInventoryEntry[]>((resolve) => {
      complete = () => resolve([])
    }))
    startWorktreeFreshnessPoll()

    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS)
    expect(crawlMock).toHaveBeenCalledTimes(1)
    // Three more periods pass while the first crawl is still in flight.
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS * 3)
    expect(crawlMock).toHaveBeenCalledTimes(1)

    complete()
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS)
    expect(crawlMock).toHaveBeenCalledTimes(2)
  })

  it('stops cleanly', async () => {
    vi.useFakeTimers()
    reposMock.mockReturnValue(['/repo-a'])
    startWorktreeFreshnessPoll()
    stopWorktreeFreshnessPoll()
    await vi.advanceTimersByTimeAsync(FRESHNESS_POLL_MS * 3)
    expect(crawlMock).not.toHaveBeenCalled()
  })
})
