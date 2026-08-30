import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Resource-bootstrap pins.
 *
 * THE BUG THESE EXIST FOR: the bootstrap read the main-process catalog exactly
 * once, at renderer mount, and memoized that promise forever. But resources
 * are producer-owned — the desktop republishes persisted charts when a session
 * SUBSCRIBES, which happens after the renderer mounts. So the read saw an
 * empty catalog, nothing ever re-read it, and the attachments panel stayed
 * blank until some later chart action produced a live delta. From the
 * operator's seat: "the charts only appear after I create a new one".
 *
 * Main now announces catalog changes and the bootstrap re-reads on that
 * signal.
 */

const store = vi.hoisted(() => ({
  state: { resources: {} as Record<string, unknown[]>, readResourceIds: new Set<string>() },
  setState: vi.fn(),
}))
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: {
    setState: (fn: (s: typeof store.state) => Partial<typeof store.state>) => {
      Object.assign(store.state, fn(store.state))
      store.setState()
    },
  },
}))
vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))

import { bootstrapResources, _resetResourceBootstrapForTest } from './useResourceBootstrap'

function item(id: string, kind = 'chart') {
  return { id, kind, producer: 'desktop', content: '{}', createdAt: '', conversationId: 'conv-a' }
}

const catalogListeners: Array<() => void> = []
let persisted: ReturnType<typeof vi.fn>

function installHarness(): void {
  store.state = { resources: {}, readResourceIds: new Set() }
  store.setState.mockClear()
  persisted = vi.fn(async () => [] as unknown[])
  catalogListeners.length = 0
  _resetResourceBootstrapForTest()
  ;(globalThis as unknown as { window: unknown }).window = {
    ion: {
      getReadResourceIds: vi.fn(async () => [] as string[]),
      getPersistedResources: persisted,
      onResourceCatalogChanged: (cb: () => void) => {
        catalogListeners.push(cb)
        return () => { /* listener lives for the window's lifetime */ }
      },
    },
  }
}

function teardownHarness(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

describe('bootstrapResources', () => {
  beforeEach(installHarness)
  afterEach(teardownHarness)

  it('re-reads the catalog on a later call instead of memoizing the first result', async () => {
    // The exact defect: the first read happens before restoration fills the
    // catalog, so a permanent memo leaves the panel empty forever.
    persisted.mockResolvedValueOnce([])
    await bootstrapResources()
    expect(store.state.resources.chart ?? []).toHaveLength(0)

    persisted.mockResolvedValueOnce([item('c1'), item('c2')])
    await bootstrapResources()

    expect(persisted).toHaveBeenCalledTimes(2)
    expect(store.state.resources.chart).toHaveLength(2)
  })

  it('coalesces concurrent callers into one read', async () => {
    persisted.mockResolvedValue([item('c1')])
    await Promise.all([bootstrapResources(), bootstrapResources(), bootstrapResources()])
    expect(persisted).toHaveBeenCalledTimes(1)
  })

  it('keeps a live item already in the store when a slower read returns', async () => {
    // A delta that landed while the read was in flight is NEWER than the
    // catalog snapshot; the read must not clobber or duplicate it.
    store.state.resources = { chart: [item('c1')] }
    persisted.mockResolvedValue([item('c1'), item('c2')])
    await bootstrapResources()

    const ids = (store.state.resources.chart as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('survives a failed read without throwing', async () => {
    // A catalog read failure must not break renderer startup.
    persisted.mockRejectedValueOnce(new Error('IPC down'))
    await expect(bootstrapResources()).resolves.toBeUndefined()
  })
})

/**
 * THE SECOND BUG THIS EXISTS FOR: the catalog-change listener was installed
 * inside `useResourceBootstrap`, a hook only the STUDIO shell mounts. The
 * Overlay calls `bootstrapResources()` directly from `useOwnerBootstrap`, so
 * in the Overlay the announcement had no listener and the panel stayed empty —
 * indistinguishable from the original defect, on a build that contained the
 * fix. The subscription now installs from the shared seam both presentations
 * call.
 */
describe('catalog-change subscription', () => {
  beforeEach(installHarness)
  afterEach(teardownHarness)

  it('installs from bootstrapResources, not from the React hook', async () => {
    await bootstrapResources()
    expect(catalogListeners).toHaveLength(1)
  })

  it('re-reads the catalog when main announces a change', async () => {
    persisted.mockResolvedValueOnce([])
    await bootstrapResources()
    expect(store.state.resources.chart ?? []).toHaveLength(0)

    // Restoration republishes; main announces; the panel must fill without any
    // further user action.
    persisted.mockResolvedValueOnce([item('c1'), item('c2')])
    catalogListeners[0]!()
    await new Promise((r) => setTimeout(r, 0))

    expect(store.state.resources.chart).toHaveLength(2)
  })

  it('installs the listener exactly once across repeated bootstraps', async () => {
    await bootstrapResources()
    await bootstrapResources()
    await bootstrapResources()
    expect(catalogListeners).toHaveLength(1)
  })
})
