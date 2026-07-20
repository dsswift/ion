import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashSnapshot, resetSnapshotHash, computeVolatileTabMetaDeltas } from '../snapshot-polling'

/**
 * Snapshot change-detection tests.
 *
 * Four groups:
 *   1. hashSnapshot() determinism & sensitivity — pure function tests,
 *      including the volatile-field exclusions (B6-1): cost/token accrual
 *      AND per-delta conversation churn (convFingerprint, lastActivityAt,
 *      lastMessage, messageCount) must not trigger a full reship.
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
    tabGroupMode: 'off',
    tabGroups: [],
    preferredModel: 'claude-sonnet-4-20250514',
    engineDefaultModel: undefined,
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
    const changed = hashSnapshot(makeSnapshotEvent({ preferredModel: 'gpt-4o' }))
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
    // convFingerprint / lastActivityAt / lastMessage / messageCount mutate on
    // EVERY streamed delta. Hashing them made the full snapshot re-serialize/
    // compress/encrypt/ship every 5 s during any active run — redundant with
    // the live delta stream. The fresh values ride the poll tick's own
    // desktop_tab_meta delta instead (computeVolatileTabMetaDeltas).
    const base = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', convFingerprint: 'a1:5', lastActivityAt: 1000, lastMessage: 'hi', messageCount: 3 }],
      }),
    )
    const churned = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', convFingerprint: 'a1:5,a2:8', lastActivityAt: 2000, lastMessage: 'hello there', messageCount: 4 }],
      }),
    )
    expect(churned).toBe(base)
  })

  it('DOES change the hash when a structural field changes even if the conversation fields also tick (B6-1)', () => {
    const base = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'running', convFingerprint: 'a1:5' }],
      }),
    )
    const structural = hashSnapshot(
      makeSnapshotEvent({
        tabs: [{ id: 'tab-1', title: 'T', workingDirectory: '/p', status: 'idle', convFingerprint: 'a1:5,a2:8' }],
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

  it('returns a different hash when tabGroupMode changes', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(makeSnapshotEvent({ tabGroupMode: 'auto' }))
    expect(changed).not.toBe(base)
  })

  it('returns a different hash when tabGroups change', () => {
    const base = hashSnapshot(makeSnapshotEvent())
    const changed = hashSnapshot(
      makeSnapshotEvent({
        tabGroups: [{ id: 'g1', label: 'Group 1', isDefault: true, order: 0 }],
      }),
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
    const deltas = computeVolatileTabMetaDeltas([tab('t1', { convFingerprint: 'a1:5', lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 })], cache)
    expect(deltas).toEqual([])
    expect(cache.get('t1')).toEqual({ convFingerprint: 'a1:5', lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 })
  })

  it('emits a delta only for the tab whose volatile fields changed, carrying only the changed fields', () => {
    const cache = new Map()
    const tick1 = [
      tab('t1', { convFingerprint: 'a1:5', lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 }),
      tab('t2', { convFingerprint: 'b1:3', lastActivityAt: 50, lastMessage: 'yo', messageCount: 1 }),
    ]
    computeVolatileTabMetaDeltas(tick1, cache)
    const tick2 = [
      tab('t1', { convFingerprint: 'a1:5,a2:8', lastActivityAt: 200, lastMessage: 'hi', messageCount: 3 }),
      tab('t2', { convFingerprint: 'b1:3', lastActivityAt: 50, lastMessage: 'yo', messageCount: 1 }),
    ]
    const deltas = computeVolatileTabMetaDeltas(tick2, cache)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toEqual({
      type: 'desktop_tab_meta',
      tabId: 't1',
      convFingerprint: 'a1:5,a2:8',
      lastActivityAt: 200,
      messageCount: 3,
      // lastMessage unchanged — NOT carried
    })
    expect('lastMessage' in deltas[0]).toBe(false)
  })

  it('emits nothing when no volatile fields changed', () => {
    const cache = new Map()
    const tabs = [tab('t1', { convFingerprint: 'a1:5', lastActivityAt: 100, lastMessage: 'hi', messageCount: 2 })]
    computeVolatileTabMetaDeltas(tabs, cache)
    const deltas = computeVolatileTabMetaDeltas(tabs, cache)
    expect(deltas).toEqual([])
  })

  it('never carries cost fields (event-wiring owns the cost tab_meta path)', () => {
    const cache = new Map()
    computeVolatileTabMetaDeltas([tab('t1', { convFingerprint: 'a1:5', runCostUsd: 0.01 })], cache)
    const deltas = computeVolatileTabMetaDeltas([tab('t1', { convFingerprint: 'a2:9', runCostUsd: 0.99 })], cache)
    expect(deltas).toHaveLength(1)
    expect('totalCostUsd' in deltas[0]).toBe(false)
    expect('runCostUsd' in deltas[0]).toBe(false)
  })

  it('sweeps cache entries for closed tabs', () => {
    const cache = new Map()
    computeVolatileTabMetaDeltas([tab('t1', { convFingerprint: 'a' }), tab('t2', { convFingerprint: 'b' })], cache)
    expect(cache.size).toBe(2)
    computeVolatileTabMetaDeltas([tab('t1', { convFingerprint: 'a' })], cache)
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
const { mockSend, mockSendToDevice, mockGetConnectedDeviceIds, mockReconcile, mockGetRemoteTabStates, mockReadSettings } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSendToDevice: vi.fn(),
  mockGetConnectedDeviceIds: vi.fn(),
  mockReconcile: vi.fn(),
  mockGetRemoteTabStates: vi.fn(),
  mockReadSettings: vi.fn(),
}))

vi.mock('../../state', () => ({
  state: {
    remoteTransport: {
      state: 'connected',
      send: mockSend,
      sendToDevice: mockSendToDevice,
      getConnectedDeviceIds: mockGetConnectedDeviceIds,
    },
    tabSnapshotInterval: null,
    mainWindow: null,
  },
  modelCache: { models: [] },
  engineBridge: null,
}))

vi.mock('../../settings-store', () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
}))

vi.mock('../snapshot', () => ({
  getRemoteTabStates: (...args: unknown[]) => mockGetRemoteTabStates(...args),
}))

vi.mock('../git-watcher-bridge', () => ({
  reconcileGitWatchedDirectories: (...args: unknown[]) => mockReconcile(...args),
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
  // ourselves.

  let pollCallback: () => Promise<void>

  function snapshotSendsToDevice(deviceId?: string) {
    return mockSendToDevice.mock.calls.filter(
      (c) => c[1]?.type === 'desktop_snapshot' && (!deviceId || c[0] === deviceId),
    )
  }

  function tabMetaBroadcasts() {
    return mockSend.mock.calls.filter((c) => c[0]?.type === 'desktop_tab_meta')
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    resetSnapshotHash()
    mockSend.mockClear()
    mockSendToDevice.mockClear()
    mockGetConnectedDeviceIds.mockClear()
    mockReconcile.mockClear()
    mockGetRemoteTabStates.mockClear()
    mockReadSettings.mockClear()

    // Default return values
    mockGetConnectedDeviceIds.mockReturnValue(['device-A'])
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [{ id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' }],
      resourceManifest: {},
    })
    mockReadSettings.mockReturnValue({
      recentBaseDirectories: ['/tmp'],
      tabGroupMode: 'off',
      tabGroups: [],
      preferredModel: 'claude-sonnet-4-20250514',
    })

    // Capture the interval callback
    const origSetInterval = globalThis.setInterval
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      cb: (...args: unknown[]) => void,
      _ms?: number,
    ) => {
      // The production callback is synchronous (`() => { void tick() }`) so the
      // async tick runs detached. Wrap it so `await pollCallback()` flushes the
      // pending microtasks and the tick's awaited work settles before we assert.
      pollCallback = async () => {
        ;(cb as () => void)()
        // Flush the microtask queue so the detached `void tick()` chain
        // (pollSnapshotOnce and its awaits) settles before assertions run.
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      // Return a fake timer id — we drive the callback manually
      return origSetInterval(() => {}, 999_999)
    }) as typeof setInterval)

    // Need a fresh import so the mock wiring applies to the module
    // scope references captured at import time.
    const { state } = await import('../../state')
    state.remoteTransport = {
      state: 'connected',
      send: mockSend,
      sendToDevice: mockSendToDevice,
      getConnectedDeviceIds: mockGetConnectedDeviceIds,
    } as any
    state.tabSnapshotInterval = null

    const { startTabSnapshotPolling } = await import('../snapshot-polling')
    startTabSnapshotPolling()

    setIntervalSpy.mockRestore()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sends the snapshot per device on the first tick (hash is new)', async () => {
    await pollCallback()
    expect(snapshotSendsToDevice('device-A')).toHaveLength(1)
  })

  it('skips send on a second identical tick', async () => {
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(1)

    mockSendToDevice.mockClear()
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(0)
  })

  it('sends again when data changes between ticks', async () => {
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(1)

    // Simulate a change: a new tab appeared
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' },
        { id: 't2', title: 'New Tab', workingDirectory: '/home', status: 'idle' },
      ],
      resourceManifest: {},
    })

    mockSendToDevice.mockClear()
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(1)
  })

  it('fingerprint-only change: NO snapshot re-send, but a tab_meta with the new fingerprint is emitted for that tab only (B6-1)', async () => {
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'running', convFingerprint: 'a1:5' },
        { id: 't2', title: 'Other', workingDirectory: '/home', status: 'idle', convFingerprint: 'b1:3' },
      ],
      resourceManifest: {},
    })
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(1)

    // Only t1's fingerprint ticks (a streamed delta landed).
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'running', convFingerprint: 'a1:5,a2:8' },
        { id: 't2', title: 'Other', workingDirectory: '/home', status: 'idle', convFingerprint: 'b1:3' },
      ],
      resourceManifest: {},
    })
    mockSendToDevice.mockClear()
    mockSend.mockClear()
    await pollCallback()

    // No full snapshot reship…
    expect(snapshotSendsToDevice()).toHaveLength(0)
    // …but exactly one tab_meta, for t1 only, carrying the new fingerprint.
    const metas = tabMetaBroadcasts()
    expect(metas).toHaveLength(1)
    expect(metas[0][0]).toMatchObject({ type: 'desktop_tab_meta', tabId: 't1', convFingerprint: 'a1:5,a2:8' })
  })

  it('no volatile changes → no tab_meta emission', async () => {
    await pollCallback()
    mockSend.mockClear()
    await pollCallback()
    expect(tabMetaBroadcasts()).toHaveLength(0)
  })

  it('per-device gate (B7): a device with a stale hash entry receives the snapshot while an up-to-date device does not', async () => {
    // Tick 1: only device-A connected — A receives and its entry is updated.
    mockGetConnectedDeviceIds.mockReturnValue(['device-A'])
    await pollCallback()
    expect(snapshotSendsToDevice('device-A')).toHaveLength(1)

    // Tick 2: device-B joins, state unchanged. B has no entry → must receive;
    // A already has the current hash → must NOT receive again.
    mockGetConnectedDeviceIds.mockReturnValue(['device-A', 'device-B'])
    mockSendToDevice.mockClear()
    await pollCallback()
    expect(snapshotSendsToDevice('device-B')).toHaveLength(1)
    expect(snapshotSendsToDevice('device-A')).toHaveLength(0)
  })

  it('always calls reconcileGitWatchedDirectories even when skipping send', async () => {
    // First tick — sends
    await pollCallback()
    expect(mockReconcile).toHaveBeenCalledTimes(1)

    // Second tick — skips send, but should still reconcile
    mockReconcile.mockClear()
    await pollCallback()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })

  it('sends again after resetSnapshotHash is called', async () => {
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(1)

    mockSendToDevice.mockClear()
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(0)

    // Reset and poll again — should send
    resetSnapshotHash()
    mockSendToDevice.mockClear()
    await pollCallback()
    expect(snapshotSendsToDevice()).toHaveLength(1)
  })
})
