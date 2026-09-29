/**
 * A thin connection's first paint and its snapshot convergence.
 *
 *  - First paint is the sync envelope, built for the connection's principal,
 *    sent to that one connection, followed by presence.
 *  - The poll tick re-sends a snapshot only when its hash changed for that
 *    principal, builds once per principal, and ignores volatile tab fields.
 *  - Settled conversations ride a gate of their own, so active-tab churn
 *    never re-sends them and a settled change reaches a client whose
 *    active-tab snapshot did not move.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendSync: vi.fn(),
  buildSnapshotEvent: vi.fn(),
  startGitWatcherBridge: vi.fn(),
  stopGitWatcherBridge: vi.fn(),
  setRemoteClientCount: vi.fn(),
  requestClientLogs: vi.fn(),
  startClientLogRequests: vi.fn(),
}))

vi.mock('../../state', () => ({ state: { remoteTransport: null } }))
vi.mock('../../remote/handlers/tabs-sync', () => ({ sendSync: mocks.sendSync }))
vi.mock('../../remote/snapshot-polling', async () => {
  const { createHash } = await import('crypto')
  return {
    buildSnapshotEvent: mocks.buildSnapshotEvent,
    // Same contract as the real gate for what this file exercises: volatile
    // per-tab fields do not move the hash. The real field list has its own
    // test (snapshot-polling-change-detection.test.ts).
    hashSnapshot: (event: { tabs?: Array<Record<string, unknown>> }) => {
      const tabs = (event.tabs ?? []).map(({ lastActivityAt: _volatile, ...stable }) => stable)
      return createHash('sha256').update(JSON.stringify({ ...event, tabs })).digest('hex')
    },
  }
})
vi.mock('../../remote/git-watcher-bridge', () => ({ startGitWatcherBridge: mocks.startGitWatcherBridge, stopGitWatcherBridge: mocks.stopGitWatcherBridge }))
vi.mock('../../git/focus-state', () => ({ focusState: { setRemoteClientCount: mocks.setRemoteClientCount } }))
vi.mock('../client-log-request', () => ({ requestClientLogs: mocks.requestClientLogs, startClientLogRequests: mocks.startClientLogRequests }))
vi.mock('../../protocol/presence', () => ({ fullPresenceSnapshot: () => ({ entries: [{ subject: 'user:alice' }], driving: {} }) }))

import { Connection, connectionRegistry } from '../../protocol/connection'
import type { ConnectionSocket } from '../../protocol/connection-socket'
import { decodeFrame } from '@ion/shared/studio-wire/codec'
import { sendThinFirstPaint, publishThinSnapshots, noteThinConnectionClosed, _resetThinSyncForTest } from '../thin-sync'

function thinConn(subject: string): { conn: Connection; payloads: () => Array<Record<string, unknown>> } {
  const sent: string[] = []
  const socket = { send: (data: string, cb?: (err?: Error) => void) => { sent.push(data); cb?.() }, close: vi.fn(), terminate: vi.fn(), on: vi.fn(), ping: vi.fn() } as unknown as ConnectionSocket
  const conn = new Connection(socket, 'tcp')
  conn.view = 'thin'
  conn.principal = { subject, displayName: subject }
  connectionRegistry.add(conn)
  return {
    conn,
    payloads: () => sent.map((text) => decodeFrame(text)).map((frame) => {
      if (frame.type !== 'studio_event') throw new Error(`unexpected frame ${frame.type}`)
      expect(frame.channel).toBe('studio:thin-event')
      return frame.payload as Record<string, unknown>
    }),
  }
}

const snapshot = (tabs: Array<Record<string, unknown>>, settledTabs: Array<Record<string, unknown>> = []) => ({ type: 'desktop_snapshot', tabs, settledTabs })

beforeEach(() => {
  for (const conn of connectionRegistry.all()) connectionRegistry.remove(conn)
  _resetThinSyncForTest()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe('sendThinFirstPaint', () => {
  it('sends the sync envelope built for the principal to that connection only, then presence', async () => {
    const alice = thinConn('user:alice')
    const bob = thinConn('user:bob')
    mocks.sendSync.mockImplementation(async (send: (event: Record<string, unknown>) => void) => {
      send(snapshot([{ id: 'tab-a', workingDirectory: '/a' }]))
      send({ type: 'desktop_settings_snapshot', settings: {} })
    })

    await sendThinFirstPaint(alice.conn)

    // The connection's scopes ride along: they decide whether the settings
    // snapshot says this client may manage the Environment.
    expect(mocks.sendSync).toHaveBeenCalledWith(expect.any(Function), 'user:alice', alice.conn.scopes)
    // The heartbeat rides first paint too: a client that has just attached
    // would otherwise read its own link as dead until the first interval.
    expect(alice.payloads().map((p) => p.type)).toEqual(['desktop_snapshot', 'desktop_settled_tabs', 'desktop_settings_snapshot', 'desktop_presence', 'desktop_heartbeat'])
    // The snapshot no longer carries them; the settled payload does.
    expect(alice.payloads()[0]).not.toHaveProperty('settledTabs')
    expect(bob.payloads()).toEqual([])
    expect([...alice.conn.thinDirectories]).toEqual(['/a'])
    expect(mocks.startGitWatcherBridge).toHaveBeenCalledTimes(1)
    // The client's log is asked for with its first paint, and the interval armed.
    expect(mocks.requestClientLogs).toHaveBeenCalledExactlyOnceWith(alice.conn)
    expect(mocks.startClientLogRequests).toHaveBeenCalledTimes(1)
    expect(mocks.setRemoteClientCount).toHaveBeenLastCalledWith(2)
  })

  it('does nothing for a mirror connection', async () => {
    const { conn, payloads } = thinConn('user:alice')
    conn.view = 'mirror'
    await sendThinFirstPaint(conn)
    expect(mocks.sendSync).not.toHaveBeenCalled()
    expect(payloads()).toEqual([])
  })
})

describe('publishThinSnapshots', () => {
  it('sends once, stays quiet while unchanged or only volatile fields move, and re-sends on a real change', async () => {
    const alice = thinConn('user:alice')
    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot([{ id: 'tab-a', title: 'A', lastActivityAt: 1, workingDirectory: '/a' }]), tabs: [] })
    await publishThinSnapshots()
    await publishThinSnapshots()
    const snapshotsOnly = () => alice.payloads().filter((p) => p.type === 'desktop_snapshot')
    expect(snapshotsOnly()).toHaveLength(1)

    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot([{ id: 'tab-a', title: 'A', lastActivityAt: 2, workingDirectory: '/a' }]), tabs: [] })
    await publishThinSnapshots()
    expect(snapshotsOnly()).toHaveLength(1)

    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot([{ id: 'tab-a', title: 'Renamed', lastActivityAt: 2, workingDirectory: '/moved' }]), tabs: [] })
    await publishThinSnapshots()
    expect(snapshotsOnly()).toHaveLength(2)
    expect([...alice.conn.thinDirectories]).toEqual(['/moved'])
  })

  it('builds once per principal and gives each connection its own principal\'s snapshot', async () => {
    const alicePhone = thinConn('user:alice')
    const aliceTablet = thinConn('user:alice')
    const bob = thinConn('user:bob')
    mocks.buildSnapshotEvent.mockImplementation(async (subject: string) => ({ event: snapshot([{ id: `tab-of-${subject}` }]), tabs: [] }))

    await publishThinSnapshots()

    expect(mocks.buildSnapshotEvent.mock.calls.map((call) => call[0])).toEqual(['user:alice', 'user:bob'])
    const tabIds = (payloads: Array<Record<string, unknown>>) => (payloads.find((p) => p.type === 'desktop_snapshot')!.tabs as Array<{ id: string }>).map((t) => t.id)
    expect(tabIds(alicePhone.payloads())).toEqual(['tab-of-user:alice'])
    expect(tabIds(aliceTablet.payloads())).toEqual(['tab-of-user:alice'])
    expect(tabIds(bob.payloads())).toEqual(['tab-of-user:bob'])
  })

  it('sends settled conversations once and never again while they are unchanged, however much the active tabs churn', async () => {
    const alice = thinConn('user:alice')
    const settled = [{ id: 'settled-1', title: 'Closed' }]
    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot([{ id: 'tab-a', title: 'A' }], settled), tabs: [] })
    await publishThinSnapshots()
    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot([{ id: 'tab-a', title: 'B' }], settled), tabs: [] })
    await publishThinSnapshots()
    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot([{ id: 'tab-a', title: 'C' }], settled), tabs: [] })
    await publishThinSnapshots()

    const byType = alice.payloads().map((p) => p.type)
    expect(byType.filter((t) => t === 'desktop_snapshot')).toHaveLength(3)
    expect(byType.filter((t) => t === 'desktop_settled_tabs')).toHaveLength(1)
    expect(alice.payloads().find((p) => p.type === 'desktop_settled_tabs')!.settledTabs).toEqual(settled)
  })

  it('sends settled conversations when they change and the active-tab snapshot did not', async () => {
    const alice = thinConn('user:alice')
    const tabs = [{ id: 'tab-a', title: 'A' }]
    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot(tabs, [{ id: 'settled-1' }]), tabs: [] })
    await publishThinSnapshots()
    mocks.buildSnapshotEvent.mockResolvedValue({ event: snapshot(tabs, [{ id: 'settled-1' }, { id: 'settled-2' }]), tabs: [] })
    await publishThinSnapshots()

    const byType = alice.payloads().map((p) => p.type)
    expect(byType.filter((t) => t === 'desktop_snapshot')).toHaveLength(1)
    const settledPayloads = alice.payloads().filter((p) => p.type === 'desktop_settled_tabs')
    expect(settledPayloads).toHaveLength(2)
    expect((settledPayloads[1].settledTabs as unknown[]).map((s) => (s as { id: string }).id)).toEqual(['settled-1', 'settled-2'])
  })

  it('a first paint primes the gate, so the next tick does not double-send', async () => {
    const alice = thinConn('user:alice')
    const event = snapshot([{ id: 'tab-a', workingDirectory: '/a' }])
    mocks.sendSync.mockImplementation(async (send: (e: Record<string, unknown>) => void) => { send(event) })
    mocks.buildSnapshotEvent.mockResolvedValue({ event, tabs: [] })
    await sendThinFirstPaint(alice.conn)
    const before = alice.payloads().length
    await publishThinSnapshots()
    // Both gates are primed by the first paint: neither the snapshot nor the
    // settled payload is repeated on the tick that follows it.
    expect(alice.payloads()).toHaveLength(before)
  })
})

describe('noteThinConnectionClosed', () => {
  it('stops the git bridge with the last client and keeps it while another remains', () => {
    const alice = thinConn('user:alice')
    const bob = thinConn('user:bob')
    connectionRegistry.remove(alice.conn)
    noteThinConnectionClosed(alice.conn)
    expect(mocks.stopGitWatcherBridge).not.toHaveBeenCalled()
    expect(mocks.setRemoteClientCount).toHaveBeenLastCalledWith(1)
    connectionRegistry.remove(bob.conn)
    noteThinConnectionClosed(bob.conn)
    expect(mocks.stopGitWatcherBridge).toHaveBeenCalledTimes(1)
    expect(mocks.setRemoteClientCount).toHaveBeenLastCalledWith(0)
  })
})
