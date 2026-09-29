import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashSnapshot, resetSnapshotHash, computeVolatileTabMetaDeltas } from '../snapshot-polling'

/**
 * Snapshot change-detection tests.
 *
 * Four groups:
 *   1. hashSnapshot() determinism & sensitivity — pure function tests,
 *      including the volatile-field exclusions (B6-1): cost/token accrual
 *      AND per-delta conversation churn (lastActivityAt, lastMessage,
 *      messageCount) must not trigger a full reship.
 *   2. computeVolatileTabMetaDeltas() — the poll tick's desktop_tab_meta
 *      delta derivation for the excluded volatile fields.
 *   3. resetSnapshotHash() — verifies the reset helper works
 *   4. Integration: the polling interval skips the snapshot send when the
 *      hash is unchanged, emits volatile tab_meta deltas instead, and still
 *      runs reconcileGitWatchedDirectories / sweepStaleEngineStatuses.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshotEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'desktop_snapshot',
    tabs: [
      {
        id: 'tab-1',
        title: 'My Tab',
        workingDirectory: '/home/user/project',
        status: 'idle' as const,
      },
    ],
    recentDirectories: ['/home/user/project'],
    availableModels: undefined,
    resources: undefined,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. hashSnapshot — determinism & sensitivity
// ---------------------------------------------------------------------------

describe('hashSnapshot', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = hashSnapshot(makeSnapshotEvent())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the same hash for identical objects', () => {
    const a = hashSnapshot(makeSnapshotEvent())
    const b = hashSnapshot(makeSnapshotEvent())
    expect(a).toBe(b)
  })

  it('returns a different hash when a scalar field changes', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(makeSnapshotEvent({ recentDirectories: ['/home/user/other'] }))
    expect(changed).not.toBe(base)
  })

  it('returns a different hash when tabs change', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(
      makeSnapshotEvent({
        tabs: [
          { id: 'tab-1', title: 'My Tab', workingDirectory: '/home/user/project', status: 'idle' },
          { id: 'tab-2', title: 'New Tab', workingDirectory: '/tmp', status: 'idle' },
        ],
      }),
    )
    expect(changed).not.toBe(base)
  })

  it('does NOT change the hash when only per-tab cost/token fields tick (RC-7)', () => {
    // Live cost accrues every poll during a run; hashing it forced a full
    // multi-tab snapshot resend every 5s. The hash must ignore the volatile
    // cost/token fields (they still ship in the payload and ride tab_meta).
    const base = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', runCostUsd: 0.01, totalCostUsd: 0.01, inputTokens: 100, outputTokens: 50 }],
      }),
    )
    const costTicked = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', runCostUsd: 0.02, totalCostUsd: 0.02, inputTokens: 200, outputTokens: 90 }],
      }),
    )
    expect(costTicked).toBe(base)
  })

  it('DOES change the hash when a structural field changes even if cost also ticks (RC-7)', () => {
    // The cost exclusion must not swallow a real structural change riding the
    // same tick — status flipping running→idle must still re-ship.
    const base = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', runCostUsd: 0.01 }],
      }),
    )
    const structural = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'idle', runCostUsd: 0.02 }],
      }),
    )
    expect(structural).not.toBe(base)
  })

  it('does NOT change the hash when only the per-delta conversation fields tick (B6-1)', () => {
    // lastActivityAt / lastMessage / messageCount mutate on
    // EVERY streamed delta. Hashing them made the full snapshot re-serialize/
    // compress/encrypt/ship every 5 s during any active run — redundant with
    // the live delta stream. The fresh values ride the poll tick's own
    // desktop_tab_meta delta instead (computeVolatileTabMetaDeltas).
    const base = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', lastActivityAt: 1000, lastMessage: 'hi', messageCount: 3 }],
      }),
    )
    const churned = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', lastActivityAt: 2000, lastMessage: 'hello there', messageCount: 4 }],
      }),
    )
    expect(churned).toBe(base)
  })

  it('DOES change the hash when a structural field changes even if the conversation fields also tick (B6-1)', () => {
    const base = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', messageCount: 1 }],
      }),
    )
    const structural = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'idle', messageCount: 2 }],
      }),
    )
    expect(structural).not.toBe(base)
  })

  it('does NOT change the hash when only the sendSync remote-display fields differ', () => {
    // sendSync layers customName/customIcon/remoteDisplayUpdatedAt on top of
    // the shared snapshot base; the poll tick does not build them. They must
    // be hash-excluded or a forced sync's hash never matches the next poll's
    // and the gate double-sends after every explicit sync.
    const base = hashSnapshot(makeSnapshotEvent())
    const layered = hashSnapshot(
      makeSnapshotEvent({ customName: 'Studio', customIcon: 'macmini', remoteDisplayUpdatedAt: 1234 }),
    )
    expect(layered).toBe(base)
  })

  it('returns a different hash when recentDirectories change', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(
      makeSnapshotEvent({ recentDirectories: ['/home/user/project', '/tmp'] }),
    )
    expect(changed).not.toBe(base)
  })

  it('returns a different hash when availableModels changes from undefined to a list', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(
      makeSnapshotEvent({
        availableModels: [
          { id: 'm1', providerId: 'p1', label: 'Model 1', contextWindow: 128000, hasAuth: true },
        ],
      }),
    )
    expect(changed).not.toBe(base)
  })

  it('returns a different hash when resources change', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(
      makeSnapshotEvent({
        resources: {
          memory: [{ id: 'r1', kind: 'memory', title: 'Note', createdAt: '2024-01-01' }],
        },
      }),
    )
    expect(changed).not.toBe(base)
  })
})

// ---------------------------------------------------------------------------
// 2. computeVolatileTabMetaDeltas — poll-tick tab_meta derivation (B6-1)
// ---------------------------------------------------------------------------

describe('computeVolatileTabMetaDeltas', () => {
  function tab(id: string, volatile: Record<string, unknown> = {}): any {
    return { id, title: 'T', status: 'idle', workingDirectory: '/p', ...volatile }
  }

  it('seeds the cache silently on first sight (values ride the full snapshot)', () => {
    const cache = new Map()
    const deltas = computeVolatileTabMetaDeltas([tab('t1', { lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 })], cache)
    expect(deltas).toEqual([])
    expect(cache.get('t1')).toEqual({ lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 })
  })

  it('emits a delta only for the tab whose volatile fields changed, carrying only the changed fields', () => {
    const cache = new Map()
    const tick1 = [
      tab('t1', { lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 }),
      tab('t2', { lastActivityAt: 50, lastMessage: 'yo', messageCount: 1 }),
    ]
    computeVolatileTabMetaDeltas(tick1, cache)
    const tick2 = [
      tab('t1', { lastActivityAt: 200, lastMessage: 'hi', messageCount: 3 }),
      tab('t2', { lastActivityAt: 50, lastMessage: 'yo', messageCount: 1 }),
    ]
    const deltas = computeVolatileTabMetaDeltas(tick2, cache)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toEqual({
      type: 'desktop_tab_meta',
      tabId: 't1',
      lastActivityAt: 200,
      messageCount: 3,
      // lastMessage unchanged — NOT carried
    })
    expect('lastMessage' in deltas[0]).toBe(false)
  })

  it('emits nothing when no volatile fields changed', () => {
    const cache = new Map()
    const tabs = [tab('t1', { lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 })]
    computeVolatileTabMetaDeltas(tabs, cache)
    const deltas = computeVolatileTabMetaDeltas(tabs, cache)
    expect(deltas).toEqual([])
  })

  it('never carries cost fields (event-wiring owns the cost tab_meta path)', () => {
    const cache = new Map()
    computeVolatileTabMetaDeltas([tab('t1', { messageCount: 1, runCostUsd: 0.01 })], cache)
    const deltas = computeVolatileTabMetaDeltas([tab('t1', { messageCount: 2, runCostUsd: 0.99 })], cache)
    expect(deltas).toHaveLength(1)
    expect('totalCostUsd' in deltas[0]).toBe(false)
    expect('runCostUsd' in deltas[0]).toBe(false)
  })

  it('sweeps cache entries for closed tabs', () => {
    const cache = new Map()
    computeVolatileTabMetaDeltas([tab('t1', { messageCount: 1 }), tab('t2', { messageCount: 2 })], cache)
    expect(cache.size).toBe(2)
    computeVolatileTabMetaDeltas([tab('t1', { messageCount: 1 })], cache)
    expect(cache.size).toBe(1)
    expect(cache.has('t2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. resetSnapshotHash
// ---------------------------------------------------------------------------

describe('resetSnapshotHash', () => {
  it('can be called without throwing', () => {
    expect(() => resetSnapshotHash()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 4. Integration: polling skips snapshot send when unchanged, emits volatile
//    tab_meta deltas, per-device gate (B7)
// ---------------------------------------------------------------------------

// We need to mock the heavy dependencies so we can drive the
// setInterval callback manually.

// vi.hoisted ensures the variables exist before vi.mock factories run
// (vi.mock calls are hoisted to the top of the file by vitest).
const { mockReconcile, mockGetRemoteTabStates, mockReadSettings, mockSendRemoteEvent } = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockGetRemoteTabStates: vi.fn(),
  mockReadSettings: vi.fn(),
  mockSendRemoteEvent: vi.fn(),
}))

// The tab_meta delta rides the studio event fan-out, whose listener is
// installed by connection wiring this test does not boot. Spy on the one
// emitter and leave the rest of remote-out real, so `thinConnections()` and
// `remoteClientsPresent()` still read the connection registered below.
vi.mock('../../thin-view/remote-out', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../thin-view/remote-out')>()),
  sendRemoteEvent: mockSendRemoteEvent,
}))

vi.mock('../../state', () => ({
  state: {
    tabSnapshotInterval: null,
    mainWindow: null,
  },
  modelCache: { models: [] },
  enterprisePolicyCache: { policy: null },
  engineBridge: null,
}))

vi.mock('../../settings-store', () => ({
  settingsDir: () => '/tmp/ion-snapshot-polling-change-test',
  readSettings: (...args: any[]) => mockReadSettings(...args),
}))

vi.mock('../snapshot', () => ({
  getRemoteTabStates: (...args: any[]) => mockGetRemoteTabStates(...args),
}))

vi.mock('../git-watcher-bridge', () => ({
  reconcileGitWatchedDirectories: (...args: any[]) => mockReconcile(...args),
}))

// The module under test imports both `log` and `debug`; mock the full logger
// surface. (An earlier mock exported only `log`, so the skip-branch `debug()`
// call threw, the tick's catch ate the error, and the "still reconciles when
// skipping send" test failed for a reason unrelated to reconciliation.)
vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

describe('startTabSnapshotPolling — change detection integration', () => {
  // We cannot easily drive the real setInterval so we capture the
  // callback that startTabSnapshotPolling registers and call it
  // ourselves. The recipient is a registered thin connection — the only
  // kind of client the tick serves.

  let pollCallback: () => Promise<void>
  let frames: () => Array<{ channel: string; payload: any }>
  let clearFrames: () => void
  let removeConnection: () => void

  async function attachThinConnection(): Promise<void> {
    const { Connection, connectionRegistry } = await import('../../protocol/connection')
    const sent: string[] = []
    const socket = { send: (data: string, cb?: (err?: Error) => void) => { sent.push(data); cb?.() }, close: vi.fn(), terminate: vi.fn(), on: vi.fn(), ping: vi.fn() }
    const conn = new Connection(socket as never, 'tcp')
    conn.view = 'thin'
    conn.principal = { subject: 'user:alice', displayName: 'alice' }
    connectionRegistry.add(conn)
    frames = () => sent.map((text) => JSON.parse(text) as { channel: string; payload: any })
    clearFrames = () => { sent.length = 0 }
    removeConnection = () => connectionRegistry.remove(conn)
  }

  function snapshots() {
    return frames().filter((f) => f.payload?.type === 'desktop_snapshot')
  }

  function tabMetas() {
    return mockSendRemoteEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e?.type === 'desktop_tab_meta')
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    resetSnapshotHash()
    const { _resetThinSyncForTest } = await import('../../thin-view/thin-sync')
    _resetThinSyncForTest()
    mockReconcile.mockClear()
    mockGetRemoteTabStates.mockClear()
    mockReadSettings.mockClear()
    mockSendRemoteEvent.mockClear()

    // Default return values
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [{ id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' }],
      resourceManifest: {},
    })
    mockReadSettings.mockReturnValue({
      recentBaseDirectories: ['/tmp'],
    })

    // Capture the interval callback
    const origSetInterval = globalThis.setInterval
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      cb: (...args: any[]) => void,
      _ms?: number,
    ) => {
      // The production callback is synchronous (`() => { void tick() }`) so the
      // async tick runs detached. Wrap it so `await pollCallback()` flushes the
      // pending microtasks and the tick's awaited work settles before we assert.
      pollCallback = async () => {
        ;(cb as () => void)()
        // Flush the microtask queue so the detached `void tick()` chain
        // (pollSnapshotOnce and its awaits) settles before assertions run.
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
      // Return a fake timer id — we drive the callback manually
      return origSetInterval(() => {}, 999_999)
    }) as typeof setInterval)

    const { state } = await import('../../state')
    state.tabSnapshotInterval = null

    const { startTabSnapshotPolling } = await import('../snapshot-polling')
    startTabSnapshotPolling()

    setIntervalSpy.mockRestore()
  })

  afterEach(() => {
    removeConnection?.()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('idles when no client is connected', async () => {
    await pollCallback()
    expect(mockGetRemoteTabStates).not.toHaveBeenCalled()
  })

  it('sends the snapshot on the first tick, on studio:thin-event, built for the connection principal', async () => {
    await attachThinConnection()
    await pollCallback()

    // The snapshot, then the settled conversations that were split out of
    // it onto their own hash gate (`thin-view/thin-settled.ts`).
    expect(frames().map((f) => f.payload.type)).toEqual(['desktop_snapshot', 'desktop_settled_tabs'])
    expect(frames()[0].channel).toBe('studio:thin-event')
    expect(frames()[0].payload.tabs.map((t: { id: string }) => t.id)).toEqual(['t1'])
    expect(mockGetRemoteTabStates).toHaveBeenCalledWith('user:alice')
  })

  it('skips send on a second identical tick', async () => {
    await attachThinConnection()
    await pollCallback()
    expect(snapshots()).toHaveLength(1)

    clearFrames()
    await pollCallback()
    expect(snapshots()).toHaveLength(0)
  })

  it('sends again when data changes between ticks', async () => {
    await attachThinConnection()
    await pollCallback()
    expect(snapshots()).toHaveLength(1)

    // Simulate a change: a new tab appeared
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' },
        { id: 't2', title: 'New Tab', workingDirectory: '/home', status: 'idle' },
      ],
      resourceManifest: {},
    })

    clearFrames()
    await pollCallback()
    expect(snapshots()).toHaveLength(1)
  })

  it('message-count-only change: NO snapshot re-send, but a tab_meta with the new count is emitted for that tab only (B6-1)', async () => {
    await attachThinConnection()
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'running', messageCount: 1 },
        { id: 't2', title: 'Other', workingDirectory: '/home', status: 'idle', messageCount: 1 },
      ],
      resourceManifest: {},
    })
    await pollCallback()
    expect(snapshots()).toHaveLength(1)

    // Only t1's count ticks (a row landed).
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'running', messageCount: 2 },
        { id: 't2', title: 'Other', workingDirectory: '/home', status: 'idle', messageCount: 1 },
      ],
      resourceManifest: {},
    })
    clearFrames()
    mockSendRemoteEvent.mockClear()
    await pollCallback()

    // No full snapshot reship…
    expect(snapshots()).toHaveLength(0)
    // …but exactly one tab_meta, for t1 only, carrying the new count.
    const metas = tabMetas()
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({ type: 'desktop_tab_meta', tabId: 't1', messageCount: 2 })
  })

  it('no volatile changes → no tab_meta emission', async () => {
    await attachThinConnection()
    await pollCallback()
    clearFrames()
    mockSendRemoteEvent.mockClear()
    await pollCallback()
    expect(tabMetas()).toHaveLength(0)
  })

  it('always calls reconcileGitWatchedDirectories even when skipping send', async () => {
    await attachThinConnection()
    // First tick — sends
    await pollCallback()
    expect(mockReconcile).toHaveBeenCalledTimes(1)

    // Second tick — skips send, but should still reconcile
    mockReconcile.mockClear()
    await pollCallback()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })
})
