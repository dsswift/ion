/**
 * remote-control-structural-push.test.ts
 *
 * RC2 pin: a STRUCTURAL renderer push must kick a snapshot evaluation
 * immediately instead of waiting out the 5s poll tick.
 *
 * The renderer publishes a fresh projection within ~250ms of any store change,
 * but nothing consumed that push as a send trigger, so a newly created tab
 * reached a paired phone only when the periodic tick came round — up to 5
 * seconds later. That was half of the observed new-tab latency.
 *
 * The counterpart property matters just as much: volatile per-delta churn
 * (cost, tokens, fingerprint, message count) must NOT kick a poll, or an active
 * run would rebuild and ship the whole multi-tab snapshot on every streamed
 * token — the flood the hash gate exists to prevent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pollSnapshotOnceMock: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (...args: any[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: (...args: any[]) => unknown) => { mocks.handlers.set(channel, fn) },
    handle: (channel: string, fn: (...args: any[]) => unknown) => { mocks.handlers.set(channel, fn) },
  },
}))

vi.mock('../../remote/snapshot-polling', () => ({
  pollSnapshotOnce: (...a: any[]) => mocks.pollSnapshotOnceMock(...a),
}))

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({
  state: { remoteTransport: null, mainWindow: null },
  pairingManager: { on: vi.fn() },
  relayDiscovery: { on: vi.fn() },
}))
vi.mock('../../settings-store', () => ({ readSettings: vi.fn().mockReturnValue({}) }))
vi.mock('../../remote/transport-init', () => ({ initRemoteTransport: vi.fn() }))
vi.mock('../../remote/revoke', () => ({ revokeDeviceLocally: vi.fn() }))
vi.mock('../../remote/handlers/diagnostics', () => ({ requestLogsFromFirstDevice: vi.fn() }))
vi.mock('../../remote/handlers/display', () => ({ setRemoteDisplay: vi.fn(), readRemoteDisplay: vi.fn() }))
vi.mock('../../remote/relay-auth', () => ({ probeRelayAuthConfig: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ isValidRemoteTabStatesPayload: () => true }))

import { registerRemoteControlIpc, _resetStructuralSnapshotGate } from '../remote-control'
import { IPC } from '../../../shared/types'

function tab(id: string, over: Record<string, unknown> = {}) {
  return {
    id, status: 'idle', groupId: null, isTerminalOnly: false,
    runCostUsd: 0, convFingerprint: '', lastActivityTs: 0, messageCount: 0,
    ...over,
  }
}

function push(tabs: unknown[]): void {
  const handler = mocks.handlers.get(IPC.REMOTE_TAB_STATES_PUSH)
  if (!handler) throw new Error('REMOTE_TAB_STATES_PUSH handler not registered')
  handler({}, { tabs, resourceManifest: {} })
}

describe('remote-control: structural push kicks a snapshot poll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    _resetStructuralSnapshotGate()
    vi.useFakeTimers()
    registerRemoteControlIpc()
  })
  afterEach(() => {
    _resetStructuralSnapshotGate()
    vi.useRealTimers()
  })

  it('polls when a tab is added', async () => {
    push([tab('t1')])            // first push seeds the signature
    await vi.advanceTimersByTimeAsync(300)
    mocks.pollSnapshotOnceMock.mockClear()

    push([tab('t1'), tab('t2')]) // structural: new tab
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.pollSnapshotOnceMock).toHaveBeenCalled()
  })

  it('polls when a tab status changes', async () => {
    push([tab('t1')])
    await vi.advanceTimersByTimeAsync(300)
    mocks.pollSnapshotOnceMock.mockClear()

    push([tab('t1', { status: 'running' })])
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.pollSnapshotOnceMock).toHaveBeenCalled()
  })

  it('polls when a tab is closed', async () => {
    push([tab('t1'), tab('t2')])
    await vi.advanceTimersByTimeAsync(300)
    mocks.pollSnapshotOnceMock.mockClear()

    push([tab('t1')])
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.pollSnapshotOnceMock).toHaveBeenCalled()
  })

  it('does NOT poll for volatile churn (cost, fingerprint, message count)', async () => {
    push([tab('t1')])
    await vi.advanceTimersByTimeAsync(300)
    mocks.pollSnapshotOnceMock.mockClear()

    // Exactly what an active run mutates on every streamed chunk. If any of
    // these entered the structural signature, a run would rebuild and ship the
    // full snapshot per token.
    push([tab('t1', { runCostUsd: 0.42, convFingerprint: 'abc:12', lastActivityTs: 999, messageCount: 7 })])
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.pollSnapshotOnceMock).not.toHaveBeenCalled()
  })

  it('collapses a burst of structural pushes into one poll', async () => {
    push([tab('t1')])
    await vi.advanceTimersByTimeAsync(300)
    mocks.pollSnapshotOnceMock.mockClear()

    push([tab('t1'), tab('t2')])
    push([tab('t1'), tab('t2'), tab('t3')])
    push([tab('t1'), tab('t2'), tab('t3'), tab('t4')])
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.pollSnapshotOnceMock).toHaveBeenCalledTimes(1)
  })
})
