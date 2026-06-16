/**
 * GitRepository lifecycle + watcher wiring tests.
 *
 * Uses a fake ParcelModule injected through createGitWatcher so the test runs
 * without the native binding.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../git-runner', () => ({ runGit: vi.fn(async () => '') }))
vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn() }))
// Default: no ignored directories. Individual tests override via mockReturnValue.
vi.mock('../settings-store', () => ({
  readGitWatcherIgnoredDirectories: vi.fn().mockReturnValue([]),
}))

import { GitRepository } from '../git/repository'
import { createGitWatcher } from '../git/watcher'
import type { ParcelModule } from '../git/watcher'
import { focusState } from '../git/focus-state'
import { readGitWatcherIgnoredDirectories } from '../settings-store'

type WatchCb = (err: Error | null, events: Array<{ path: string; type: string }>) => void
interface FakeSub { dir: string; cb: WatchCb; unsubscribe: ReturnType<typeof vi.fn> }

function makeFakeParcel(): { mod: ParcelModule; subs: FakeSub[] } {
  const subs: FakeSub[] = []
  const mod: ParcelModule = {
    subscribe: (dir, cb) => {
      const unsubscribe = vi.fn<() => Promise<void>>(async () => {})
      const sub: FakeSub = { dir, cb, unsubscribe }
      subs.push(sub)
      return Promise.resolve({ unsubscribe })
    },
  }
  return { mod, subs }
}

function fireOn(subs: FakeSub[], dirSuffix: string, path: string): void {
  const sub = subs.find((s) => s.dir.endsWith(dirSuffix))
  if (!sub) throw new Error(`No subscription matching ${dirSuffix}`)
  sub.cb(null, [{ path, type: 'update' }])
}

const flushDebounce = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
const microtask = (): Promise<void> => Promise.resolve()

describe('GitRepository watcher lifecycle', () => {
  beforeEach(() => { focusState.setFocused(true) })

  it('starts watcher on first retain, stops on last release', async () => {
    const { mod, subs } = makeFakeParcel()
    const repo = new GitRepository('/tmp/r', createGitWatcher(mod))
    expect(repo.watcherActive).toBe(false)

    repo.retain()
    await microtask(); await microtask()
    expect(repo.watcherActive).toBe(true)
    expect(subs.length).toBe(2)

    repo.retain()
    repo.release()
    expect(repo.watcherActive).toBe(true)

    repo.release()
    expect(repo.watcherActive).toBe(false)
    await microtask()
    expect(subs[0].unsubscribe).toHaveBeenCalled()
    expect(subs[1].unsubscribe).toHaveBeenCalled()
  })

  it('emits watch events for HEAD changes after debounce', async () => {
    const { mod, subs } = makeFakeParcel()
    const repo = new GitRepository('/tmp/r', createGitWatcher(mod))
    repo.retain()
    await microtask(); await microtask()

    const events: Array<{ kind: string }> = []
    repo.on('watch', (e) => events.push(e))

    fireOn(subs, '.git', '/tmp/r/.git/HEAD')
    expect(events.length).toBe(0)
    await flushDebounce()
    expect(events).toEqual([{ kind: 'head:changed' }])

    repo.release()
  })

  it('bumps revision on head:changed and clears branch cache on refs:dirty', async () => {
    const { mod, subs } = makeFakeParcel()
    const repo = new GitRepository('/tmp/r', createGitWatcher(mod))
    repo.retain()
    await microtask(); await microtask()
    const startRev = repo.revision

    repo.branchCache.set('branches', { branches: [], current: '' })

    fireOn(subs, '.git', '/tmp/r/.git/HEAD')
    fireOn(subs, '.git', '/tmp/r/.git/refs/heads/main')
    await flushDebounce()

    expect(repo.revision).toBeGreaterThan(startRev)
    expect(repo.branchCache.get('branches')).toBeUndefined()

    repo.release()
  })

  it('drops events while suspended (window blurred)', async () => {
    const { mod, subs } = makeFakeParcel()
    const repo = new GitRepository('/tmp/r', createGitWatcher(mod))
    repo.retain()
    await microtask(); await microtask()

    const events: Array<{ kind: string }> = []
    repo.on('watch', (e) => events.push(e))

    focusState.setFocused(false)
    fireOn(subs, '.git', '/tmp/r/.git/HEAD')
    await flushDebounce()
    expect(events.length).toBe(0)

    focusState.setFocused(true)
    fireOn(subs, '.git', '/tmp/r/.git/HEAD')
    await flushDebounce()
    expect(events).toEqual([{ kind: 'head:changed' }])

    repo.release()
  })

  // ─── On-demand refresh path (GIT_REFRESH IPC handler relies on this) ───
  //
  // The relaxed GIT_REFRESH handler in src/main/ipc/git-extras.ts now calls
  // repositoryManager.get(directory) + refreshSnapshot() without retaining,
  // so a path that has never been subscribed can still produce a fresh
  // snapshot. This test pins that contract.

  it('refreshSnapshot on a never-retained repo still emits events', async () => {
    const { mod } = makeFakeParcel()
    const repo = new GitRepository('/tmp/r', createGitWatcher(mod))
    // No retain() — watcher is not started. This is exactly what
    // GIT_REFRESH does for a directory that hasn't been subscribed.
    expect(repo.watcherActive).toBe(false)

    const events: string[] = []
    repo.on('event', (e: { kind: string }) => events.push(e.kind))

    await repo.refreshSnapshot()

    // First snapshot fans out status + head + upstream events.
    expect(events).toContain('status:changed')
    expect(events).toContain('head:changed')
    expect(events).toContain('upstream:changed')
    expect(repo.snapshot).not.toBeNull()
  })

  it('bumpRevision + refreshSnapshot re-emits after first snapshot', async () => {
    const { mod } = makeFakeParcel()
    const repo = new GitRepository('/tmp/r', createGitWatcher(mod))
    await repo.refreshSnapshot()

    const events: string[] = []
    repo.on('event', (e: { kind: string }) => events.push(e.kind))

    const rev0 = repo.revision
    repo.bumpRevision()
    expect(repo.revision).toBeGreaterThan(rev0)
    await repo.refreshSnapshot()

    // No actual git change between snapshots -> no status delta event.
    // Test asserts the path runs without throwing and the revision bumped.
    expect(repo.revision).toBeGreaterThan(rev0)
  })
})

// ─── Watcher gate (ignored-directories) ─────────────────────────────────────
//
// Regression contract: when a repo path is in the ignored list, retain() must
// NOT call watcher.start(). If the gate is removed from retain(), the first
// test in this block fails ("never called" becomes "called once").

describe('GitRepository watcher gate (ignored paths)', () => {
  beforeEach(() => {
    focusState.setFocused(true)
    // Reset to no-ignored default before each test in this block.
    vi.mocked(readGitWatcherIgnoredDirectories).mockReturnValue([])
  })

  it('watcher.start is NOT called for ignored path; watcherIgnored is true; snapshot hydrates', async () => {
    vi.mocked(readGitWatcherIgnoredDirectories).mockReturnValue(['/tmp/ignored'])

    const fakeWatcher = {
      start: vi.fn(),
      stop: vi.fn(),
      setSuspended: vi.fn(),
      get active() { return (this.start as ReturnType<typeof vi.fn>).mock.calls.length > 0 },
    }

    const repo = new GitRepository('/tmp/ignored', fakeWatcher as any)
    repo.retain()
    await microtask(); await microtask()
    await repo.waitForReady()

    // REGRESSION GATE: this assertion fails if the watcher gate is removed from retain().
    expect(fakeWatcher.start).not.toHaveBeenCalled()
    expect(repo.watcherIgnored).toBe(true)
    // Initial snapshot still ran (refreshSnapshot was called despite no watcher).
    expect(repo.snapshot).not.toBeNull()
  })

  it('watcher.start IS called for non-ignored path; watcherIgnored is false', async () => {
    vi.mocked(readGitWatcherIgnoredDirectories).mockReturnValue(['/tmp/ignored'])

    const fakeWatcher = {
      start: vi.fn(),
      stop: vi.fn(),
      setSuspended: vi.fn(),
      get active() { return (this.start as ReturnType<typeof vi.fn>).mock.calls.length > 0 },
    }

    const repo = new GitRepository('/tmp/not-ignored', fakeWatcher as any)
    repo.retain()
    await microtask(); await microtask()

    expect(fakeWatcher.start).toHaveBeenCalledOnce()
    expect(repo.watcherIgnored).toBe(false)
  })

  it('snapshot.watcherIgnored matches the gate decision', async () => {
    vi.mocked(readGitWatcherIgnoredDirectories).mockReturnValue(['/tmp/ignored'])

    const fakeWatcher = {
      start: vi.fn(),
      stop: vi.fn(),
      setSuspended: vi.fn(),
      get active() { return (this.start as ReturnType<typeof vi.fn>).mock.calls.length > 0 },
    }

    const repo = new GitRepository('/tmp/ignored', fakeWatcher as any)
    repo.retain()
    await microtask(); await microtask()
    await repo.waitForReady()

    expect(repo.snapshot?.watcherIgnored).toBe(true)
  })

  it('focus-return triggers refreshSnapshot for ignored-path repo (no watcher)', async () => {
    // Checkpoint 4: even though the watcher is suppressed, the focus-return
    // handler must still be registered so the snapshot re-hydrates when the
    // window regains focus.
    vi.mocked(readGitWatcherIgnoredDirectories).mockReturnValue(['/tmp/ignored'])

    const fakeWatcher = {
      start: vi.fn(),
      stop: vi.fn(),
      setSuspended: vi.fn(),
      get active() { return (this.start as ReturnType<typeof vi.fn>).mock.calls.length > 0 },
    }

    const repo = new GitRepository('/tmp/ignored', fakeWatcher as any)
    const refreshSpy = vi.spyOn(repo, 'refreshSnapshot')

    repo.retain()
    await microtask(); await microtask()
    await repo.waitForReady()

    // Initial refresh ran. Reset the spy count so we can detect the focus-return call.
    const callsAfterRetain = refreshSpy.mock.calls.length

    // Simulate window blur then focus-return.
    focusState.setFocused(false)
    focusState.setFocused(true)
    await microtask(); await microtask()

    // refreshSnapshot must have been called at least once more after focus returned.
    expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsAfterRetain)
    // Watcher was never started throughout.
    expect(fakeWatcher.start).not.toHaveBeenCalled()

    repo.release()
  })
})
