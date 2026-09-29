/**
 * Pins the signal that replaced the Explorer's refresh timer: one watch per
 * root however many subscribers, a bounded notice once a burst settles, and
 * nothing left running when the last subscriber is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { FsTreeChange } from '@ion/shared/fs-tree-watch'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: (p: string) => typeof p === 'string' && p.startsWith('/') }))

import { createTreeWatchRegistry, TREE_MAX_DIRECTORIES, TREE_MAX_WAIT_MS, TREE_SETTLE_MS } from '../tree-watch'
import type { WatchEvent, WatchModule, WatchOptions } from '../../fs-watch/chokidar-watch-module'

interface FakeWatch {
  mod: WatchModule
  subscribed: Array<{ dir: string; opts?: WatchOptions }>
  unsubscribed: string[]
  emit: (dir: string, paths: string[]) => void
  fault: (dir: string, message: string) => void
}

function fakeWatch(): FakeWatch {
  const callbacks = new Map<string, (err: Error | null, events: WatchEvent[]) => void>()
  const subscribed: FakeWatch['subscribed'] = []
  const unsubscribed: string[] = []
  return {
    subscribed,
    unsubscribed,
    mod: {
      subscribe: async (dir, cb, opts) => {
        subscribed.push({ dir, opts })
        callbacks.set(dir, cb)
        return { unsubscribe: async () => { unsubscribed.push(dir) } }
      },
    },
    emit: (dir, paths) => callbacks.get(dir)?.(null, paths.map((path) => ({ path, type: 'update' }))),
    fault: (dir, message) => callbacks.get(dir)?.(new Error(message), []),
  }
}

function subscriber(id: string): { id: string; send: (change: FsTreeChange) => void; received: FsTreeChange[] } {
  const received: FsTreeChange[] = []
  return { id, received, send: (change) => { received.push(change) } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('tree watch', () => {
  it('reports the directories that changed, relative to the root, once the burst settles', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const client = subscriber('conn-1')
    expect(registry.watch(client, { root: '/repo' })).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(0)

    watch.emit('/repo', [join('/repo', 'a.txt'), join('/repo', 'src', 'x.ts')])
    watch.emit('/repo', [join('/repo', 'src', 'y.ts'), join('/repo', 'src', 'deep', 'z.ts')])
    expect(client.received).toEqual([])

    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    expect(client.received).toEqual([
      { root: '/repo', directories: ['', 'src', 'src/deep'], overflow: false, ignoreRulesChanged: false },
    ])
  })

  it('asks the watch module for no event typing, which costs a filesystem probe per event', async () => {
    const watch = fakeWatch()
    createTreeWatchRegistry(watch.mod).watch(subscriber('conn-1'), { root: '/repo' })
    expect(watch.subscribed).toEqual([{ dir: '/repo', opts: { resolveType: false } }])
  })

  it('still reports a directory that never stops changing', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const client = subscriber('conn-1')
    registry.watch(client, { root: '/repo' })
    await vi.advanceTimersByTimeAsync(0)

    for (let elapsed = 0; elapsed < TREE_MAX_WAIT_MS; elapsed += 100) {
      watch.emit('/repo', [join('/repo', 'log', 'out.txt')])
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(client.received.length).toBeGreaterThanOrEqual(1)
    expect(client.received[0].directories).toEqual(['log'])
  })

  it('reports overflow instead of a list when a burst touches too many directories', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const client = subscriber('conn-1')
    registry.watch(client, { root: '/repo' })
    await vi.advanceTimersByTimeAsync(0)

    watch.emit('/repo', Array.from({ length: TREE_MAX_DIRECTORIES + 1 }, (_, i) => join('/repo', 'node_modules', `pkg${i}`, 'index.js')))
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    expect(client.received).toEqual([{ root: '/repo', directories: [], overflow: true, ignoreRulesChanged: false }])

    // The next burst starts clean.
    watch.emit('/repo', [join('/repo', 'a.txt')])
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    expect(client.received[1]).toEqual({ root: '/repo', directories: [''], overflow: false, ignoreRulesChanged: false })
  })

  it('flags a change to the ignore rules', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const client = subscriber('conn-1')
    registry.watch(client, { root: '/repo' })
    await vi.advanceTimersByTimeAsync(0)

    watch.emit('/repo', [join('/repo', 'desktop', '.gitignore')])
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    watch.emit('/repo', [join('/repo', '.git', 'info', 'exclude')])
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    watch.emit('/repo', [join('/repo', 'src', 'gitignore.ts')])
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    expect(client.received.map((c) => c.ignoreRulesChanged)).toEqual([true, true, false])
  })

  it('tells subscribers to re-read when the watch faults', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const client = subscriber('conn-1')
    registry.watch(client, { root: '/repo' })
    await vi.advanceTimersByTimeAsync(0)

    watch.fault('/repo', 'buffer overflow')
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    expect(client.received).toEqual([{ root: '/repo', directories: [], overflow: true, ignoreRulesChanged: false }])
  })

  it('shares one watch per root and closes it when the last subscriber leaves', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const first = subscriber('conn-1')
    const second = subscriber('conn-2')
    registry.watch(first, { root: '/repo' })
    registry.watch(second, { root: '/repo' })
    registry.watch(first, { root: '/repo' })
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.subscribed).toHaveLength(1)

    watch.emit('/repo', [join('/repo', 'a.txt')])
    await vi.advanceTimersByTimeAsync(TREE_SETTLE_MS)
    expect(first.received).toHaveLength(1)
    expect(second.received).toHaveLength(1)

    registry.unwatch('conn-1', { root: '/repo' })
    expect(watch.unsubscribed).toEqual([])
    registry.unwatch('conn-2', { root: '/repo' })
    expect(watch.unsubscribed).toEqual(['/repo'])
    expect(registry.watchedRoots()).toEqual([])

    watch.emit('/repo', [join('/repo', 'b.txt')])
    await vi.advanceTimersByTimeAsync(TREE_MAX_WAIT_MS)
    expect(first.received).toHaveLength(1)
    expect(second.received).toHaveLength(1)
  })

  it('releases every root a closed connection held', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    const gone = subscriber('conn-gone')
    const stays = subscriber('conn-stays')
    registry.watch(gone, { root: '/repo-a' })
    registry.watch(gone, { root: '/repo-b' })
    registry.watch(stays, { root: '/repo-b' })
    await vi.advanceTimersByTimeAsync(0)

    registry.unwatchAll('conn-gone')
    expect(watch.unsubscribed).toEqual(['/repo-a'])
    expect(registry.watchedRoots()).toEqual(['/repo-b'])
  })

  it('closes a watch whose last subscriber left before it finished starting', async () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    registry.watch(subscriber('conn-1'), { root: '/repo' })
    registry.unwatch('conn-1', { root: '/repo' })
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.unsubscribed).toEqual(['/repo'])
  })

  it('refuses a root that is not a valid project path', () => {
    const watch = fakeWatch()
    const registry = createTreeWatchRegistry(watch.mod)
    expect(registry.watch(subscriber('conn-1'), { root: 'relative' })).toEqual({ ok: false, error: 'Invalid path' })
    expect(watch.subscribed).toEqual([])
  })
})
