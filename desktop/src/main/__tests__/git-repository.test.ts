/**
 * GitRepository lifecycle + watcher wiring tests.
 *
 * Uses a fake ParcelModule injected through createGitWatcher so the test runs
 * without the native binding.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../git-runner', () => ({ runGit: vi.fn(async () => '') }))
vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn() }))

import { GitRepository } from '../git/repository'
import { createGitWatcher } from '../git/watcher'
import type { ParcelModule } from '../git/watcher'
import { focusState } from '../git/focus-state'

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
})
