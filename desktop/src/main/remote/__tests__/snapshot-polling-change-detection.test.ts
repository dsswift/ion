import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hashSnapshot, resetSnapshotHash } from '../snapshot-polling'

/**
 * Snapshot change-detection tests (Fix 1).
 *
 * Three groups:
 *   1. hashSnapshot() determinism & sensitivity — pure function tests
 *   2. resetSnapshotHash() — verifies the reset helper works
 *   3. Integration: the polling interval skips send when the hash
 *      is unchanged, but still runs reconcileGitWatchedDirectories
 *      and sweepStaleEngineStatuses
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
// 2. resetSnapshotHash
// ---------------------------------------------------------------------------

describe('resetSnapshotHash', () => {
  it('can be called without throwing', () => {
    expect(() => resetSnapshotHash()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. Integration: polling skips send when snapshot is unchanged
// ---------------------------------------------------------------------------

// We need to mock the heavy dependencies so we can drive the
// setInterval callback manually.

// vi.hoisted ensures the variables exist before vi.mock factories run
// (vi.mock calls are hoisted to the top of the file by vitest).
const { mockSend, mockReconcile, mockGetRemoteTabStates, mockReadSettings } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockReconcile: vi.fn(),
  mockGetRemoteTabStates: vi.fn(),
  mockReadSettings: vi.fn(),
}))

vi.mock('../../state', () => ({
  state: {
    remoteTransport: { state: 'connected', send: mockSend },
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

vi.mock('../../logger', () => ({
  log: vi.fn(),
}))

describe('startTabSnapshotPolling — change detection integration', () => {
  // We cannot easily drive the real setInterval so we capture the
  // callback that startTabSnapshotPolling registers and call it
  // ourselves.

  let pollCallback: () => Promise<void>

  beforeEach(async () => {
    vi.useFakeTimers()
    resetSnapshotHash()
    mockSend.mockClear()
    mockReconcile.mockClear()
    mockGetRemoteTabStates.mockClear()
    mockReadSettings.mockClear()

    // Default return values
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
      pollCallback = cb as () => Promise<void>
      // Return a fake timer id — we drive the callback manually
      return origSetInterval(() => {}, 999_999)
    }) as typeof setInterval)

    // Need a fresh import so the mock wiring applies to the module
    // scope references captured at import time.
    const { state } = await import('../../state')
    state.remoteTransport = { state: 'connected', send: mockSend } as any
    state.tabSnapshotInterval = null

    const { startTabSnapshotPolling } = await import('../snapshot-polling')
    startTabSnapshotPolling()

    setIntervalSpy.mockRestore()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sends the snapshot on the first tick (hash is new)', async () => {
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(1)
    const sentEvent = mockSend.mock.calls[0][0]
    expect(sentEvent.type).toBe('desktop_snapshot')
  })

  it('skips send on a second identical tick', async () => {
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(1)

    mockSend.mockClear()
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(0)
  })

  it('sends again when data changes between ticks', async () => {
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(1)

    // Simulate a change: a new tab appeared
    mockGetRemoteTabStates.mockResolvedValue({
      tabs: [
        { id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' },
        { id: 't2', title: 'New Tab', workingDirectory: '/home', status: 'idle' },
      ],
      resourceManifest: {},
    })

    mockSend.mockClear()
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(1)
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
    expect(mockSend).toHaveBeenCalledTimes(1)

    mockSend.mockClear()
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(0)

    // Reset and poll again — should send
    resetSnapshotHash()
    mockSend.mockClear()
    await pollCallback()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})
