/**
 * Tests for `createGitWatcher`'s real subscribe/debounce/stop behavior,
 * driven by a fake `WatchModule` (this behavior had no direct test before
 * the 2026-09-16 chokidar migration — classify/exempt tests covered only
 * adjacent helpers).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { join } from 'path'
import { createGitWatcher, resolveWatchModule, type GitWatchEvent, type WatchEvent, type WatchModule } from '../watcher'
import { defaultWatchModule } from '../../fs-watch/native-recursive-watch-module'

/** A fake WatchModule that records subscribe/unsubscribe calls and lets the test drive events. */
function createFakeWatchModule(): {
  module: WatchModule
  emit: (dir: string, events: WatchEvent[]) => void
  subscribeCalls: string[]
  subscribeOptions: Array<{ ignore?: string[]; resolveType?: boolean } | undefined>
  unsubscribeCalls: string[]
} {
  const callbacks = new Map<string, (err: Error | null, events: WatchEvent[]) => void>()
  const subscribeCalls: string[] = []
  const subscribeOptions: Array<{ ignore?: string[]; resolveType?: boolean } | undefined> = []
  const unsubscribeCalls: string[] = []

  const module: WatchModule = {
    subscribe: async (dir, cb, opts) => {
      subscribeCalls.push(dir)
      subscribeOptions.push(opts)
      callbacks.set(dir, cb)
      return {
        unsubscribe: async () => {
          unsubscribeCalls.push(dir)
          callbacks.delete(dir)
        },
      }
    },
  }

  return {
    module,
    subscribeCalls,
    subscribeOptions,
    unsubscribeCalls,
    emit: (dir, events) => callbacks.get(dir)?.(null, events),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('resolveWatchModule', () => {
  it('returns the injected fake when one is passed', () => {
    const fake = createFakeWatchModule()
    expect(resolveWatchModule(fake.module)).toBe(fake.module)
  })

  it('forces the no-op path when null is passed explicitly', () => {
    expect(resolveWatchModule(null)).toBe(null)
  })

  it('resolves to the real native recursive watch module when nothing is passed', () => {
    expect(resolveWatchModule()).toBe(defaultWatchModule)
  })
})

describe('createGitWatcher', () => {
  it('subscribes to both the .git directory and the working tree on start', () => {
    const fake = createFakeWatchModule()
    const watcher = createGitWatcher(fake.module)
    watcher.start('/repo', vi.fn())
    expect(fake.subscribeCalls).toEqual([join('/repo', '.git'), '/repo'])
  })

  it('asks for no event typing: it reads only the path, and typing costs a filesystem probe per event', () => {
    const fake = createFakeWatchModule()
    createGitWatcher(fake.module).start('/repo', vi.fn())
    expect(fake.subscribeOptions.map((o) => o?.resolveType)).toEqual([false, false])
  })

  it('classifies a .git/HEAD change and emits it after the debounce window', async () => {
    const fake = createFakeWatchModule()
    const events: GitWatchEvent[] = []
    const watcher = createGitWatcher(fake.module)
    watcher.start('/repo', (e) => events.push(e))

    fake.emit(join('/repo', '.git'), [{ path: join('/repo', '.git', 'HEAD'), type: 'update' }])
    expect(events).toEqual([]) // not flushed yet -- still inside the debounce window

    await vi.advanceTimersByTimeAsync(260)
    expect(events).toEqual([{ kind: 'head:changed' }])
  })

  it('classifies any working-tree event as status:dirty', async () => {
    const fake = createFakeWatchModule()
    const events: GitWatchEvent[] = []
    const watcher = createGitWatcher(fake.module)
    watcher.start('/repo', (e) => events.push(e))

    fake.emit('/repo', [{ path: '/repo/src/index.ts', type: 'update' }])
    await vi.advanceTimersByTimeAsync(260)
    expect(events).toEqual([{ kind: 'status:dirty' }])
  })

  it('drops pending events instead of flushing them while suspended', async () => {
    const fake = createFakeWatchModule()
    const events: GitWatchEvent[] = []
    const watcher = createGitWatcher(fake.module)
    watcher.start('/repo', (e) => events.push(e))

    watcher.setSuspended(true)
    fake.emit('/repo', [{ path: '/repo/src/index.ts', type: 'update' }])
    await vi.advanceTimersByTimeAsync(260)
    expect(events).toEqual([])
  })

  it('unsubscribes both subscriptions on stop', async () => {
    const fake = createFakeWatchModule()
    const watcher = createGitWatcher(fake.module)
    watcher.start('/repo', vi.fn())
    await vi.advanceTimersByTimeAsync(0) // let both subscribe() promises settle

    watcher.stop()
    await vi.advanceTimersByTimeAsync(0) // let both unsubscribe() promises settle
    expect(fake.unsubscribeCalls.sort()).toEqual([join('/repo', '.git'), '/repo'].sort())
    expect(watcher.active).toBe(false)
  })

  it('falls back to a no-op watcher when the watch module is explicitly unavailable', () => {
    const watcher = createGitWatcher(null)
    expect(() => watcher.start('/repo', vi.fn())).not.toThrow()
    expect(watcher.active).toBe(false)
  })
})
