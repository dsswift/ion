import { describe, it, expect, afterEach, vi } from 'vitest'
import { startHarness, connectLocal as connectHarnessLocal, type Harness } from '@ion/server/protocol/__tests__/harness'
import { resetConnectionRegistryForTest } from '@ion/server/protocol/__tests__/harness'
import { connectionRegistry } from '@ion/server/protocol/connection'
import { Broker, type ConnectionTarget } from '../broker'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { WIRE_PING_CAPABILITY } from '@ion/shared/studio-wire/types'
import { probeConnection } from '@ion/server/protocol/wire-latency-probe'

/** Wires a Broker target straight at a running test harness's local (Unix socket) listener. */
function targetFor(harness: Harness, environmentId = 'env-local'): ConnectionTarget {
  return {
    environmentId,
    label: 'Local Test Environment',
    transport: 'local',
    clientId: `desktop-${environmentId}`,
    capabilities: ['graph'],
    open: () => Promise.resolve({ transport: 'local' as const, credential: { kind: 'local' as const }, socket: connectHarnessLocal(harness) }),
  }
}

describe('Broker', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    // harness.close() walks connectionRegistry to close every still-open
    // socket before the underlying WebSocketServer.close() call, which
    // itself doesn't resolve until every tracked socket disconnects.
    // Clearing the registry first (the old order here) left it empty by the
    // time close() ran, so the raw socket was never told to close and
    // wss.close() hung until the afterEach hook timeout.
    await harness?.close()
    resetConnectionRegistryForTest()
    harness = undefined
  })

  it('delivers a studio_welcome frame once connected to a fake local server', async () => {
    harness = await startHarness()
    const broker = new Broker()
    const received: StudioFrame[] = []
    broker.onFrame((_envId, frame) => received.push(frame))

    broker.connect(targetFor(harness))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for studio_welcome')), 3000)
      const off = broker.onFrame((_envId, frame) => {
        if (frame.type === 'studio_welcome') {
          clearTimeout(timer)
          off()
          resolve()
        }
      })
    })

    expect(received.some((f) => f.type === 'studio_welcome')).toBe(true)
    expect(broker.phaseOf('env-local')?.phase).toBe('connected')
  })

  it('advertises the target capabilities in its hello, so the server can route reverse commands to it', async () => {
    harness = await startHarness()
    const broker = new Broker()
    broker.connect(targetFor(harness, 'env-caps'))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for connection')), 3000)
      const off = broker.onFrame((_envId, frame) => {
        if (frame.type === 'studio_welcome') {
          clearTimeout(timer)
          off()
          resolve()
        }
      })
    })

    const conn = connectionRegistry.findByCapability('graph')
    expect(conn).toBeDefined()
    expect(conn?.clientKind).toBe('desktop')
    expect(connectionRegistry.findByCapability('browser')).toBeUndefined()
  })

  // A paired proof is an HMAC over a server nonce that rotates and resets on
  // restart, so the credential belongs to the attempt, not to the target.
  it('derives the credential once per attempt, including every reconnect', async () => {
    harness = await startHarness()
    const broker = new Broker()
    let refreshes = 0
    const target: ConnectionTarget = {
      ...targetFor(harness),
      open: () => {
        refreshes++
        return Promise.resolve({ transport: 'local' as const, credential: { kind: 'local' as const }, socket: connectHarnessLocal(harness as Harness) })
      },
    }
    broker.connect(target)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for studio_welcome')), 3000)
      const off = broker.onFrame((_envId, frame) => { if (frame.type === 'studio_welcome') { clearTimeout(timer); off(); resolve() } })
    })
    expect(refreshes).toBe(1)
    // A reconnect derives it again: the server's nonce may have rotated or reset.
    broker.restart('env-local')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the second studio_welcome')), 3000)
      const off = broker.onFrame((_envId, frame) => { if (frame.type === 'studio_welcome') { clearTimeout(timer); off(); resolve() } })
    })
    expect(refreshes).toBe(2)
  })

  it('round-trips a studio_action through send/onFrame using sendAction', async () => {
    harness = await startHarness()
    const broker = new Broker()
    broker.connect(targetFor(harness, 'env-action'))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for connection')), 3000)
      const off = broker.onFrame((_envId, frame) => {
        if (frame.type === 'studio_welcome') {
          clearTimeout(timer)
          off()
          resolve()
        }
      })
    })

    // toggleExpanded is a MIRROR_LOCAL_ACTIONS entry (not in the studio_action
    // registry), so the request must come back as `unknown_action` rather
    // than hang -- this proves the round trip through the real server rather
    // than a mocked one.
    await expect(broker.sendAction('env-action', 'toggleExpanded', [])).rejects.toThrow()
  })

  /**
   * The existing round-trip test above waits for `studio_welcome` before it
   * sends anything, which is exactly the case the old `send()` handled. This
   * one sends IMMEDIATELY after `connect()`, before the socket is open and
   * long before the server has welcomed it.
   *
   * That was a silent drop: `send()` logged a warning and returned, so the
   * caller's promise hung until its timeout with nothing to explain it. It
   * only became load-bearing when the renderer started routing ordinary work
   * over this wire -- that work begins during boot, well before the
   * connection is up.
   */
  it('holds a frame sent before the wire is ready and delivers it once welcomed', async () => {
    harness = await startHarness()
    const broker = new Broker()
    broker.connect(targetFor(harness, 'env-queued'))

    // No wait: the connection cannot possibly be open on this tick.
    const pending = broker.sendAction('env-queued', 'toggleExpanded', [])

    // A real answer from the real server -- `unknown_action` rather than a
    // timeout -- proves the frame survived the gap instead of being dropped.
    await expect(pending).rejects.toThrow(/unknown_action|toggleExpanded/)
  })

  it('holds a frame sent before connect() is even called and delivers it once the connection exists', async () => {
    // The Studio renderer's first actions leave a few milliseconds before
    // the main process connects the LOCAL Environment. A send with no
    // connection used to vanish, and each of those actions timed out at 30s
    // -- the splash sat on "Workspace ready" for that long on every launch.
    harness = await startHarness()
    const broker = new Broker()
    const pending = broker.sendAction('env-early', 'toggleExpanded', [])
    broker.connect(targetFor(harness, 'env-early'))
    await expect(pending).rejects.toThrow(/unknown_action|toggleExpanded/)
  })

  it('decodes a binary FILE_CHUNK frame sent by the server and delivers it via onBinary', async () => {
    harness = await startHarness()
    const broker = new Broker()
    broker.connect(targetFor(harness, 'env-binary'))

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for connection')), 3000)
      const off = broker.onFrame((_envId, frame) => {
        if (frame.type === 'studio_welcome') {
          clearTimeout(timer)
          off()
          resolve()
        }
      })
    })

    // The server's real Connection.sendBinary encodes the same wire format
    // the transfer.export handler streams archive chunks through -- using it
    // here (rather than hand-encoding bytes) proves the broker decodes what
    // the server actually sends, not a shape convenient for the test.
    const serverConn = connectionRegistry.all()[0]
    if (!serverConn) throw new Error('expected the harness to register one server-side connection')
    const payload = new Uint8Array([1, 2, 3, 4, 5])

    const received = await new Promise<{ environmentId: string; channel: number; key: string; payload: Uint8Array }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), 3000)
        broker.onBinary((environmentId, channel, key, framePayload) => {
          clearTimeout(timer)
          resolve({ environmentId, channel, key, payload: framePayload })
        })
        serverConn.sendBinary(BinaryChannel.FILE_CHUNK, 'transfer-abc', payload)
      },
    )

    expect(received.environmentId).toBe('env-binary')
    expect(received.channel).toBe(BinaryChannel.FILE_CHUNK)
    expect(received.key).toBe('transfer-abc')
    expect(Array.from(received.payload)).toEqual(Array.from(payload))
  })

  it('reports offline after five failed connection attempts', async () => {
    vi.useFakeTimers()
    try {
      const broker = new Broker()
      const phases: string[] = []
      broker.onPhase((_envId, phase) => phases.push(phase.phase))

      broker.connect({
        environmentId: 'env-broken',
        label: 'Unreachable',
        transport: 'local',
        clientId: 'desktop-env-broken',
        open: () => Promise.reject(new Error('refused')),
      })

      // Ladder: 1s, 2s, 4s, 8s, 8s(capped) -- five retries, the sixth failure
      // (which never schedules another retry) lands on `offline`.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(8000)
      }

      expect(phases.filter((p) => p === 'backoff').length).toBeGreaterThanOrEqual(4)
      expect(broker.phaseOf('env-broken')?.phase).toBe('offline')
      broker.disconnect('env-broken')
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers the server\'s latency probe, so the round trip is measured end to end', async () => {
    // The whole point of the measure: one clock, both readings. The server
    // times send-to-answer itself, so no clock-skew correction is needed and
    // it reads the same for every client and route.
    harness = await startHarness()
    const broker = new Broker()
    const target = { ...targetFor(harness), capabilities: ['graph', WIRE_PING_CAPABILITY] }
    broker.connect(target)
    await vi.waitFor(() => expect(connectionRegistry.all()).toHaveLength(1), { timeout: 5_000 })
    const serverSide = connectionRegistry.all()[0]
    await vi.waitFor(() => expect(serverSide.clientId).not.toBeNull(), { timeout: 5_000 })

    expect(probeConnection(serverSide)).toBe(true)

    // The pong comes back over the real socket and lands on the server's meter.
    await vi.waitFor(() => {
      const window = serverSide.latency.takeWindow()
      expect(window.rtt_samples).toBe(1)
      expect(window.rtt_p50_ms).toBeGreaterThanOrEqual(0)
    }, { timeout: 5_000 })

    broker.disconnect(target.environmentId)
  })

  it('is never probed when it does not claim it can answer', async () => {
    // A client that predates the frame would refuse to decode it and its
    // connection would close -- far worse than a missing measurement.
    harness = await startHarness()
    const broker = new Broker()
    const target = targetFor(harness) // capabilities: ['graph'] only
    broker.connect(target)
    await vi.waitFor(() => expect(connectionRegistry.all()).toHaveLength(1), { timeout: 5_000 })
    const serverSide = connectionRegistry.all()[0]
    await vi.waitFor(() => expect(serverSide.clientId).not.toBeNull(), { timeout: 5_000 })

    expect(probeConnection(serverSide)).toBe(false)

    broker.disconnect(target.environmentId)
  })
})
