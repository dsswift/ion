/**
 * Tests for corpus-store.ts (child 03 additions): watch wiring, delta
 * ordering (snapshot replaced before broadcast), empty-delta suppression,
 * and config-change reconfiguration.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  subscribeCorpus,
  getCachedSnapshot,
  _resetCorpusStoreForTest,
  _setCorpusWatcherForTest,
  reconfigureCorpusWatch,
  deriveWatchState,
} from './corpus-store'
import { IPC } from '../../shared/types-ipc'
import * as configStore from './config-store'
import { broadcast } from '../broadcast'
import { GRAPH_VIEW_DEFAULTS } from '../../shared/graph-view-types'
import type { GraphViewConfig } from '../../shared/graph-view-types'
import type { ParcelEvent, ParcelModule, ParcelSubscription } from './corpus-watch'

function baseConfig(roots: string[]): GraphViewConfig {
  return {
    corpusRoots: roots.map((path) => ({ path })),
    identityField: GRAPH_VIEW_DEFAULTS.identityField,
    labelField: GRAPH_VIEW_DEFAULTS.labelField,
    tagField: GRAPH_VIEW_DEFAULTS.tagField,
    groupFields: GRAPH_VIEW_DEFAULTS.groupFields,
    edgeFields: GRAPH_VIEW_DEFAULTS.edgeFields,
    hoverFields: GRAPH_VIEW_DEFAULTS.hoverFields,
    curatedFields: [],
    promotedFields: [],
    savedViews: [],
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: GRAPH_VIEW_DEFAULTS.sectionNodes,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
  }
}

function createFakeParcel(): { module: ParcelModule; emit: (dir: string, events: ParcelEvent[]) => void } {
  const callbacks = new Map<string, (err: Error | null, events: ParcelEvent[]) => void>()
  const module: ParcelModule = {
    subscribe: async (dir, cb) => {
      callbacks.set(dir, cb)
      const sub: ParcelSubscription = { unsubscribe: async () => { callbacks.delete(dir) } }
      return sub
    },
  }
  return { module, emit: (dir, events) => callbacks.get(dir)?.(null, events) }
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-view-corpus-store-'))
  vi.useFakeTimers()
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  _resetCorpusStoreForTest()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('subscription refcounts', () => {
  it('acquires one config watch for the first subscriber and releases it after the last', async () => {
    mkdirSync(tmpRoot, { recursive: true })
    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([]))
    const watchProject = vi.spyOn(configStore, 'watchProject')
    const unwatchProject = vi.spyOn(configStore, 'unwatchProject')

    await subscribeCorpus(tmpRoot)
    await subscribeCorpus(tmpRoot)
    expect(watchProject).toHaveBeenCalledTimes(1)

    const { unsubscribeCorpus } = await import('./corpus-store')
    unsubscribeCorpus(tmpRoot)
    expect(unwatchProject).not.toHaveBeenCalled()
    unsubscribeCorpus(tmpRoot)
    expect(unwatchProject).toHaveBeenCalledWith(tmpRoot)
  })
})


describe('delta ordering', () => {
  it('the cached snapshot reflects the delta at the moment broadcast is called', async () => {
    mkdirSync(tmpRoot, { recursive: true })
    const filePath = join(tmpRoot, 'a.md')
    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([tmpRoot]))
    const fake = createFakeParcel()
    _setCorpusWatcherForTest(fake.module)

    await subscribeCorpus('/project')
    await vi.runAllTimersAsync()

    let sawUpdatedSnapshotAtBroadcast = false
    vi.mocked(broadcast).mockImplementation((_channel, ..._args) => {
      const snap = getCachedSnapshot('/project')
      sawUpdatedSnapshotAtBroadcast = !!snap?.documents.some((d) => d.path === filePath)
    })

    writeFileSync(filePath, '---\nid: a\n---\n')
    fake.emit(tmpRoot, [{ path: filePath, type: 'create' }])
    await vi.advanceTimersByTimeAsync(260)

    expect(broadcast).toHaveBeenCalled()
    expect(sawUpdatedSnapshotAtBroadcast).toBe(true)
  })

  it('an empty delta neither broadcasts nor advances the cached revision', async () => {
    mkdirSync(tmpRoot, { recursive: true })
    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([tmpRoot]))
    const fake = createFakeParcel()
    _setCorpusWatcherForTest(fake.module)

    const snapshot = await subscribeCorpus('/project')
    await vi.runAllTimersAsync()
    const revisionBefore = snapshot.revision

    // A non-.md event carries no path our onFlush would treat as a real
    // upsert/removal (a file that doesn't exist and was never known).
    fake.emit(tmpRoot, [{ path: join(tmpRoot, 'never-existed.md'), type: 'delete' }])
    await vi.advanceTimersByTimeAsync(260)

    expect(broadcast).not.toHaveBeenCalled()
    expect(getCachedSnapshot('/project')?.revision).toBe(revisionBefore)
  })
})

describe('reconfigureCorpusWatch', () => {
  it('removed roots drop their documents and added roots are scanned, in one delta', async () => {
    const rootA = join(tmpRoot, 'a')
    const rootB = join(tmpRoot, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    writeFileSync(join(rootA, 'x.md'), '---\nid: x\n---\n')

    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([rootA]))
    const fake = createFakeParcel()
    _setCorpusWatcherForTest(fake.module)

    await subscribeCorpus('/project')
    await vi.runAllTimersAsync()

    writeFileSync(join(rootB, 'y.md'), '---\nid: y\n---\n')
    await reconfigureCorpusWatch('/project', baseConfig([rootB]))

    const snap = getCachedSnapshot('/project')
    expect(snap?.documents.some((d) => d.path === join(rootA, 'x.md'))).toBe(false)
    expect(snap?.documents.some((d) => d.path === join(rootB, 'y.md'))).toBe(true)
    expect(broadcast).toHaveBeenCalled()
  })
})

describe('per-root watch degradation', () => {
  it('a failed root subscription downgrades the snapshot to partial and broadcasts one roots-only delta', async () => {
    const rootA = join(tmpRoot, 'a')
    const rootB = join(tmpRoot, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([rootA, rootB]))
    const rejecting: ParcelModule = {
      subscribe: async (dir) => {
        if (dir === rootB) throw new Error('EMFILE')
        return { unsubscribe: async () => {} }
      },
    }
    _setCorpusWatcherForTest(rejecting)

    const initial = await subscribeCorpus('/project')
    expect(initial.watchState).toBe('watching')
    await vi.runAllTimersAsync()

    const snap = getCachedSnapshot('/project')
    expect(snap?.watchState).toBe('partial')
    expect(snap?.roots.find((r) => r.path === rootA)?.watch).toBe('watching')
    expect(snap?.roots.find((r) => r.path === rootB)?.watch).toBe('failed')

    const rootsOnly = vi.mocked(broadcast).mock.calls.filter(([channel]) => channel === IPC.GRAPH_CORPUS_DELTA)
    // Only the failure is broadcast; root A resolving to `watching` confirms
    // the initial snapshot and produces no delta.
    expect(rootsOnly).toHaveLength(1)
    const last = rootsOnly[rootsOnly.length - 1][2] as { upserted: unknown[]; removedPaths: unknown[]; watchState?: string }
    expect(last.upserted).toEqual([])
    expect(last.removedPaths).toEqual([])
    expect(last.watchState).toBe('partial')
  })

  it('a document delta after a failure keeps the failed root marked', async () => {
    const rootA = join(tmpRoot, 'a')
    const rootB = join(tmpRoot, 'b')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    vi.spyOn(configStore, 'getGraphViewConfig').mockReturnValue(baseConfig([rootA, rootB]))
    const callbacks = new Map<string, (err: Error | null, events: ParcelEvent[]) => void>()
    const module: ParcelModule = {
      subscribe: async (dir, cb) => {
        if (dir === rootB) throw new Error('EMFILE')
        callbacks.set(dir, cb)
        return { unsubscribe: async () => {} }
      },
    }
    _setCorpusWatcherForTest(module)
    await subscribeCorpus('/project')
    await vi.runAllTimersAsync()

    const filePath = join(rootA, 'x.md')
    writeFileSync(filePath, '---\nid: x\n---\n')
    callbacks.get(rootA)!(null, [{ path: filePath, type: 'create' }])
    await vi.advanceTimersByTimeAsync(260)

    const snap = getCachedSnapshot('/project')
    expect(snap?.documents.some((d) => d.path === filePath)).toBe(true)
    expect(snap?.roots.find((r) => r.path === rootB)?.watch).toBe('failed')
    expect(snap?.watchState).toBe('partial')
  })

  it('deriveWatchState: unavailable module wins, any failed root is partial, else watching', () => {
    expect(deriveWatchState([{ path: '/a', exists: true, documentCount: 0, watch: 'watching' }], false)).toBe('unavailable')
    expect(deriveWatchState([{ path: '/a', exists: true, documentCount: 0, watch: 'watching' }, { path: '/b', exists: true, documentCount: 0, watch: 'failed' }], true)).toBe('partial')
    expect(deriveWatchState([{ path: '/a', exists: true, documentCount: 0, watch: 'watching' }, { path: '/b', exists: true, documentCount: 0 }], true)).toBe('watching')
  })
})
