/**
 * Tests for corpus-watch.ts (child 03), driven by a fake `ParcelModule` per
 * the pattern in `main/git/watcher.ts`'s own tests.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCorpusWatcher, type ParcelEvent, type ParcelModule, type ParcelSubscription } from './corpus-watch'
import * as logger from '../logger'

/** A fake ParcelModule that records subscribe calls and lets the test drive events. */
function createFakeParcel(): {
  module: ParcelModule
  emit: (dir: string, events: ParcelEvent[]) => void
  subscribeCalls: string[]
  unsubscribeCalls: string[]
} {
  const callbacks = new Map<string, (err: Error | null, events: ParcelEvent[]) => void>()
  const subscribeCalls: string[] = []
  const unsubscribeCalls: string[] = []

  const module: ParcelModule = {
    subscribe: async (dir, cb) => {
      subscribeCalls.push(dir)
      callbacks.set(dir, cb)
      const sub: ParcelSubscription = {
        unsubscribe: async () => {
          unsubscribeCalls.push(dir)
          callbacks.delete(dir)
        },
      }
      return sub
    },
  }

  return {
    module,
    subscribeCalls,
    unsubscribeCalls,
    emit: (dir, events) => {
      const cb = callbacks.get(dir)
      if (cb) cb(null, events)
    },
  }
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-view-watch-'))
  vi.useFakeTimers()
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  vi.useRealTimers()
  vi.clearAllMocks()
})

function flushCallbacks(): ((paths: Set<string>) => void) & { calls: Set<string>[]; mock: { calls: unknown[][] } } {
  const calls: Set<string>[] = []
  const onFlush = vi.fn((paths: Set<string>) => calls.push(paths))
  return Object.assign(onFlush, { calls })
}

describe('start', () => {
  it('subscribes one watcher per existing root', () => {
    const fake = createFakeParcel()
    const rootA = join(tmpRoot, 'a')
    const rootB = join(tmpRoot, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    const watcher = createCorpusWatcher(fake.module)
    const onFlush = flushCallbacks()

    watcher.start('/project', [{ path: rootA }, { path: rootB }], {
      onFlush,
      getKnownPathsUnderPrefix: () => [],
      onRootWatchState: vi.fn(),
    })

    expect(fake.subscribeCalls).toEqual([rootA, rootB])
  })

  it('skips a root that does not exist on disk', () => {
    const fake = createFakeParcel()
    const watcher = createCorpusWatcher(fake.module)
    watcher.start('/project', [{ path: join(tmpRoot, 'missing') }], {
      onFlush: vi.fn(),
      getKnownPathsUnderPrefix: () => [],
      onRootWatchState: vi.fn(),
    })
    expect(fake.subscribeCalls).toEqual([])
  })
})

describe('debounce and flush', () => {
  it('a burst of events produces exactly one onFlush after the debounce', async () => {
    const fake = createFakeParcel()
    mkdirSync(tmpRoot, { recursive: true })
    const watcher = createCorpusWatcher(fake.module)
    const onFlush = flushCallbacks()

    watcher.start('/project', [{ path: tmpRoot }], { onFlush, getKnownPathsUnderPrefix: () => [], onRootWatchState: vi.fn() })
    await vi.runAllTimersAsync() // let the subscribe promise resolve

    const events: ParcelEvent[] = []
    for (let i = 0; i < 500; i++) {
      events.push({ path: join(tmpRoot, `f${i}.md`), type: 'create' })
    }
    fake.emit(tmpRoot, events)

    expect(onFlush).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(260)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('a create+delete pair in one window nets correctly via caller resolution', async () => {
    const fake = createFakeParcel()
    mkdirSync(tmpRoot, { recursive: true })
    const filePath = join(tmpRoot, 'a.md')
    writeFileSync(filePath, '---\nid: a\n---\n')
    const watcher = createCorpusWatcher(fake.module)
    const onFlush = flushCallbacks()

    watcher.start('/project', [{ path: tmpRoot }], { onFlush, getKnownPathsUnderPrefix: () => [], onRootWatchState: vi.fn() })
    await vi.runAllTimersAsync()

    fake.emit(tmpRoot, [
      { path: filePath, type: 'create' },
      { path: filePath, type: 'delete' },
    ])
    await vi.advanceTimersByTimeAsync(260)

    expect(onFlush).toHaveBeenCalledTimes(1)
    // The .md path is included; the caller (corpus-store) resolves
    // existence at flush time via computeDelta, which this watcher does
    // not decide.
    expect(onFlush.calls[0].has(filePath)).toBe(true)
  })

  it('a directory delete resolves via getKnownPathsUnderPrefix', async () => {
    const fake = createFakeParcel()
    mkdirSync(tmpRoot, { recursive: true })
    const dirPath = join(tmpRoot, 'sub')
    const watcher = createCorpusWatcher(fake.module)
    const knownPath = join(dirPath, 'known.md')
    const onFlush = flushCallbacks()

    watcher.start('/project', [{ path: tmpRoot }], {
      onFlush,
      getKnownPathsUnderPrefix: (dir) => (dir === dirPath ? [knownPath] : []),
      onRootWatchState: vi.fn(),
    })
    await vi.runAllTimersAsync()

    // dirPath does not exist on disk (it was deleted), so the watcher asks
    // the caller for its known member paths.
    fake.emit(tmpRoot, [{ path: dirPath, type: 'delete' }])
    await vi.advanceTimersByTimeAsync(260)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.calls[0].has(knownPath)).toBe(true)
  })

  it('a directory create expands to its .md files on disk', async () => {
    const fake = createFakeParcel()
    mkdirSync(tmpRoot, { recursive: true })
    const dirPath = join(tmpRoot, 'sub')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'x.md'), '---\nid: x\n---\n')
    writeFileSync(join(dirPath, 'y.md'), '---\nid: y\n---\n')
    const watcher = createCorpusWatcher(fake.module)
    const onFlush = flushCallbacks()

    watcher.start('/project', [{ path: tmpRoot }], { onFlush, getKnownPathsUnderPrefix: () => [], onRootWatchState: vi.fn() })
    await vi.runAllTimersAsync()

    fake.emit(tmpRoot, [{ path: dirPath, type: 'create' }])
    await vi.advanceTimersByTimeAsync(260)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.calls[0].has(join(dirPath, 'x.md'))).toBe(true)
    expect(onFlush.calls[0].has(join(dirPath, 'y.md'))).toBe(true)
  })
})

describe('module unavailable', () => {
  it('a failing require falls back to a no-op watcher: no throw, unavailable, one WARN', () => {
    const warnSpy = vi.mocked(logger.warn)
    warnSpy.mockClear()

    const failingRequire = () => {
      throw new Error('module not found')
    }
    const watcher = createCorpusWatcher(null, failingRequire)

    expect(watcher.available).toBe(false)
    expect(() => watcher.start('/project', [{ path: tmpRoot }], { onFlush: vi.fn(), getKnownPathsUnderPrefix: () => [], onRootWatchState: vi.fn() })).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith('main', 'graph_view: corpus watcher unavailable', { reason: 'module-not-found' })
  })
})

describe('per-root watch state', () => {
  it('reports watching once a root subscription resolves', async () => {
    const fake = createFakeParcel()
    mkdirSync(tmpRoot, { recursive: true })
    const watcher = createCorpusWatcher(fake.module)
    const onRootWatchState = vi.fn()

    watcher.start('/project', [{ path: tmpRoot }], { onFlush: vi.fn(), getKnownPathsUnderPrefix: () => [], onRootWatchState })
    await vi.runAllTimersAsync()

    expect(onRootWatchState).toHaveBeenCalledWith(tmpRoot, 'watching', 'subscribed')
  })

  it('a rejecting subscribe reports failed with the error and logs WARN', async () => {
    const rootA = join(tmpRoot, 'a')
    const rootB = join(tmpRoot, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    const rejecting: ParcelModule = {
      subscribe: async (dir) => {
        if (dir === rootA) throw new Error('EMFILE: too many open files')
        return { unsubscribe: async () => {} }
      },
    }
    const watcher = createCorpusWatcher(rejecting)
    const onRootWatchState = vi.fn()

    watcher.start('/project', [{ path: rootA }, { path: rootB }], { onFlush: vi.fn(), getKnownPathsUnderPrefix: () => [], onRootWatchState })
    await vi.runAllTimersAsync()

    expect(onRootWatchState).toHaveBeenCalledWith(rootA, 'failed', 'EMFILE: too many open files')
    expect(onRootWatchState).toHaveBeenCalledWith(rootB, 'watching', 'subscribed')
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('main', 'graph_view: corpus watch subscribe failed', { rootPath: rootA, error: 'EMFILE: too many open files' })
  })

  it('a runtime watch error reports failed', async () => {
    const callbacks = new Map<string, (err: Error | null, events: ParcelEvent[]) => void>()
    const module: ParcelModule = {
      subscribe: async (dir, cb) => {
        callbacks.set(dir, cb)
        return { unsubscribe: async () => {} }
      },
    }
    mkdirSync(tmpRoot, { recursive: true })
    const watcher = createCorpusWatcher(module)
    const onRootWatchState = vi.fn()

    watcher.start('/project', [{ path: tmpRoot }], { onFlush: vi.fn(), getKnownPathsUnderPrefix: () => [], onRootWatchState })
    await vi.runAllTimersAsync()
    callbacks.get(tmpRoot)!(new Error('watcher died'), [])

    expect(onRootWatchState).toHaveBeenLastCalledWith(tmpRoot, 'failed', 'watcher died')
  })

  it('a missing root is skipped without a watch-state report', () => {
    const fake = createFakeParcel()
    const watcher = createCorpusWatcher(fake.module)
    const onRootWatchState = vi.fn()
    watcher.start('/project', [{ path: join(tmpRoot, 'missing') }], { onFlush: vi.fn(), getKnownPathsUnderPrefix: () => [], onRootWatchState })
    expect(onRootWatchState).not.toHaveBeenCalled()
  })
})

describe('unreadable directory during a directory-create expansion', () => {
  // chmod 0o000 simulates an unreadable directory through POSIX permission
  // bits. Windows has no such bit-based model (it uses ACLs), so chmod is a
  // near no-op there and the directory stays readable — the scenario this
  // test exists to create cannot occur on that platform. Mirrors the existing
  // precedent for OS-permission-dependent tests (e.g.
  // src/main/deeplink/__tests__/handoff.test.ts, token.test.ts).
  it.skipIf(process.platform === 'win32')('logs WARN for the unreadable subtree and still flushes the readable siblings', async () => {
    const fake = createFakeParcel()
    mkdirSync(tmpRoot, { recursive: true })
    const created = join(tmpRoot, 'created')
    const locked = join(created, 'locked')
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(created, 'ok.md'), '---\nid: ok\n---\n')
    writeFileSync(join(locked, 'hidden.md'), '---\nid: hidden\n---\n')
    chmodSync(locked, 0o000)

    const watcher = createCorpusWatcher(fake.module)
    const onFlush = flushCallbacks()
    watcher.start('/project', [{ path: tmpRoot }], { onFlush, getKnownPathsUnderPrefix: () => [], onRootWatchState: vi.fn() })
    await vi.runAllTimersAsync()

    try {
      fake.emit(tmpRoot, [{ path: created, type: 'create' }])
      await vi.advanceTimersByTimeAsync(260)
    } finally {
      chmodSync(locked, 0o700)
    }

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.calls[0].has(join(created, 'ok.md'))).toBe(true)
    expect(onFlush.calls[0].has(join(locked, 'hidden.md'))).toBe(false)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('main', 'graph_view: corpus watch directory unreadable', expect.objectContaining({ dir: locked }))
  })
})
