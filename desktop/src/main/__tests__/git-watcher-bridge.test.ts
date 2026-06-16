/**
 * Git watcher bridge tests.
 *
 * Uses the same fake-parcel pattern as git-repository.test.ts and mocks
 * broadcastGitChanges so we can count broadcasts without running git.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('../git-runner', () => ({ runGit: vi.fn(async () => '') }))
vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn() }))
vi.mock('../remote/git-broadcast', () => ({ broadcastGitChanges: vi.fn(async () => {}) }))
// repository.ts imports settings-store (for readGitWatcherIgnoredDirectories),
// which transitively imports utils/secretStore → 'electron'. Under
// `npm ci --ignore-scripts` (CI) the Electron binary is not installed, so an
// eager electron import throws "Electron failed to install correctly" and this
// test file fails to load. Mock settings-store the same way git-repository.test.ts
// and the other repository-importing tests do — the watcher-bridge test drives a
// fake parcel watcher and does not care about real settings or the keychain.
vi.mock('../settings-store', () => ({
  readGitWatcherIgnoredDirectories: vi.fn().mockReturnValue([]),
}))

import { GitRepository } from '../git/repository'
import { createGitWatcher } from '../git/watcher'
import type { ParcelModule } from '../git/watcher'
import { focusState } from '../git/focus-state'
import {
  startGitWatcherBridge,
  stopGitWatcherBridge,
  reconcileGitWatchedDirectories,
} from '../remote/git-watcher-bridge'
import { broadcastGitChanges } from '../remote/git-broadcast'
import { repositoryManager } from '../git/repositoryManager'

const mockBroadcast = broadcastGitChanges as ReturnType<typeof vi.fn>

// ─── Fake Parcel helpers ───────────────────────────────────────────────────

type WatchCb = (err: Error | null, events: Array<{ path: string; type: string }>) => void
interface FakeSub { dir: string; cb: WatchCb; unsubscribe: ReturnType<typeof vi.fn> }

function makeFakeParcel(): { mod: ParcelModule; subs: FakeSub[] } {
  const subs: FakeSub[] = []
  const mod: ParcelModule = {
    subscribe: (dir, cb) => {
      const unsubscribe = vi.fn<() => Promise<void>>(async () => {})
      subs.push({ dir, cb, unsubscribe })
      return Promise.resolve({ unsubscribe })
    },
  }
  return { mod, subs }
}

const flushDebounce = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
const microtask = (): Promise<void> => Promise.resolve()
const tick = async (): Promise<void> => { await microtask(); await microtask() }

// Patch repositoryManager.get to create repos backed by a given fake watcher module.
function patchManager(mod: ParcelModule): void {
  vi.spyOn(repositoryManager, 'get').mockImplementation((path: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (repositoryManager as any).repos as Map<string, GitRepository>
    let repo = map.get(path)
    if (!repo) {
      repo = new GitRepository(path, createGitWatcher(mod))
      map.set(path, repo)
    }
    return repo
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('git-watcher-bridge', () => {
  beforeEach(() => {
    focusState.setFocused(true)
    mockBroadcast.mockClear()
  })

  afterEach(() => {
    stopGitWatcherBridge()
    vi.restoreAllMocks()
  })

  it('start retains repos and sends initial broadcasts', async () => {
    const { mod } = makeFakeParcel()
    patchManager(mod)

    startGitWatcherBridge(new Set(['/tmp/a', '/tmp/b']))
    await tick()

    expect(repositoryManager.get('/tmp/a').refCount).toBeGreaterThanOrEqual(1)
    expect(repositoryManager.get('/tmp/b').refCount).toBeGreaterThanOrEqual(1)
    expect(mockBroadcast).toHaveBeenCalledWith('/tmp/a')
    expect(mockBroadcast).toHaveBeenCalledWith('/tmp/b')
  })

  it('reconcile releases repos removed from the directory set', async () => {
    const { mod } = makeFakeParcel()
    patchManager(mod)

    startGitWatcherBridge(new Set(['/tmp/x']))
    await tick()
    const refBefore = repositoryManager.get('/tmp/x').refCount

    reconcileGitWatchedDirectories(new Set())
    await tick()

    expect(repositoryManager.get('/tmp/x').refCount).toBe(refBefore - 1)
  })

  it('watcher event triggers broadcast after debounce', async () => {
    const { mod, subs } = makeFakeParcel()
    patchManager(mod)

    startGitWatcherBridge(new Set(['/tmp/watch']))
    await tick()
    mockBroadcast.mockClear()  // Ignore initial broadcast

    // Fire a .git HEAD event to trigger the watcher debounce
    const gitSub = subs.find(s => s.dir.endsWith('.git'))
    gitSub?.cb(null, [{ path: '/tmp/watch/.git/HEAD', type: 'update' }])
    await flushDebounce()

    expect(mockBroadcast).toHaveBeenCalledWith('/tmp/watch')
  })

  it('stop releases all retained repos', async () => {
    const { mod } = makeFakeParcel()
    patchManager(mod)

    startGitWatcherBridge(new Set(['/tmp/p', '/tmp/q']))
    await tick()

    const refP = repositoryManager.get('/tmp/p').refCount
    const refQ = repositoryManager.get('/tmp/q').refCount

    stopGitWatcherBridge()
    await tick()

    expect(repositoryManager.get('/tmp/p').refCount).toBe(refP - 1)
    expect(repositoryManager.get('/tmp/q').refCount).toBe(refQ - 1)
  })

  it('stop while already stopped is a no-op', () => {
    expect(() => stopGitWatcherBridge()).not.toThrow()
  })

  it('reconcile is a no-op when bridge is not active', () => {
    expect(() => reconcileGitWatchedDirectories(new Set(['/tmp/z']))).not.toThrow()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })
})
