/**
 * Unit-level (fake WebSocket, no real socket) coverage for two defects
 * fixed alongside `renderer/host/BrowserStudioHost.ts`'s identical ones:
 *
 * 1. A `close`/`error` firing on a socket this connection has already moved
 *    past used to be treated as if it described the current connection --
 *    nulling `this.ws` out from under a perfectly healthy newer socket and
 *    triggering an immediate, needless reconnect.
 * 2. Once the retry ladder exhausted (5 attempts), the connection gave up
 *    forever with `phase: 'offline'` and no timer -- a server restart or a
 *    long network outage left it dead until a manual Restart action.
 *
 * The existing `broker.test.ts` covers the real, harness-backed connect
 * path; this file is deliberately fake-socket-based so these two failure
 * shapes (a stale event landing late, a long unbroken run of failures) can
 * be driven directly without real socket timing.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Broker, type ConnectionTarget } from '../broker'

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1
  readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []

  constructor() {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  simulateMessage(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false)
  }

  simulateClose(code = 1005, reason = ''): void {
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  simulateError(): void {
    this.emit('error', new Error('fake socket error'))
  }
}

/** `target.open()` must itself construct the socket, matching a real transport factory -- each call pushes a fresh instance onto FakeWebSocket.instances. */
function targetSpawning(environmentId = 'env-local'): ConnectionTarget {
  return {
    environmentId,
    label: 'Test Environment',
    transport: 'local',
    clientId: `desktop-${environmentId}`,
    open: () => Promise.resolve({
      transport: 'local' as const,
      credential: { kind: 'local' as const },
      socket: new FakeWebSocket() as unknown as Awaited<ReturnType<ConnectionTarget['open']>>['socket'],
    }),
  }
}

/** Lets the attempt's own promise settle: `open()` is async, so its socket exists one microtask after connect()/restart(). */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function welcomeFrame(): Record<string, unknown> {
  return {
    type: 'studio_welcome',
    protocolVersion: 1,
    environmentId: 'a1b2c3d4-uuid-not-local',
    label: 'Test Server',
    platform: 'linux',
    serverVersion: '0.0.0',
    engineVersion: '0.0.0',
    capabilities: [],
    principal: { subject: 'local:test' },
    scopes: [],
    enterprisePolicy: null,
    settingsHiddenGroups: [], developerSurfaces: { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true }, policyHash: 'sha256:test',
    snapshot: {},
  }
}

describe('Broker stale socket events', () => {
  it('ignores a close event firing on a socket already superseded by a newer one', async () => {
    FakeWebSocket.instances.length = 0
    const broker = new Broker()
    broker.connect(targetSpawning())
    await flush()
    const first = FakeWebSocket.instances[0]
    first.simulateOpen()
    first.simulateMessage(welcomeFrame())
    expect(broker.phaseOf('env-local')?.phase).toBe('connected')

    // restart() is the manual path a caller uses while a socket is live;
    // the point under test is what happens to the OLD socket's own late
    // events once it has been superseded, regardless of what superseded it.
    broker.restart('env-local')
    await flush()
    const second = FakeWebSocket.instances[1]
    expect(second).toBeDefined()
    second.simulateOpen()
    second.simulateMessage(welcomeFrame())
    expect(broker.phaseOf('env-local')?.phase).toBe('connected')

    // The stale close arrives late, as it does in production.
    first.simulateClose(1005, '')

    expect(broker.phaseOf('env-local')?.phase).toBe('connected')
    broker.send('env-local', { type: 'studio_action', id: 'after-stale-close', action: 'model.list', args: [] } as never)
    expect(second.sent.some((s) => JSON.parse(s).id === 'after-stale-close')).toBe(true)
  })

  it('schedules only one reconnect when a socket fires both error and close for the same failure', async () => {
    vi.useFakeTimers()
    try {
      FakeWebSocket.instances.length = 0
      const broker = new Broker()
      broker.connect(targetSpawning())
      await flush()
      const first = FakeWebSocket.instances[0]
      first.simulateOpen()
      first.simulateMessage(welcomeFrame())

      first.simulateError()
      first.simulateClose(1006, '')

      await vi.advanceTimersByTimeAsync(5000)
      expect(FakeWebSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying at the slow cadence instead of stopping forever once the ladder is exhausted', async () => {
    vi.useFakeTimers()
    try {
      FakeWebSocket.instances.length = 0
      const broker = new Broker()
      broker.connect(targetSpawning())
      await flush()

      // MAX_ATTEMPTS is 5: the first 5 failures walk the fast ladder
      // (scheduling a retry each time), and only the 6th tips
      // `attempts > MAX_ATTEMPTS` into 'offline'. 8000ms comfortably covers
      // every rung, including the ladder's own 8000ms max.
      for (let i = 0; i < 6; i++) {
        const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
        sock.simulateClose(1006, '')
        if (i < 5) await vi.advanceTimersByTimeAsync(8000)
      }
      expect(broker.phaseOf('env-local')?.phase).toBe('offline')
      const countAtOffline = FakeWebSocket.instances.length

      // Advance well past the 30s offline retry cadence -- a dead-forever
      // connection would never open another socket here.
      await vi.advanceTimersByTimeAsync(31_000)
      expect(FakeWebSocket.instances.length).toBeGreaterThan(countAtOffline)
    } finally {
      vi.useRealTimers()
    }
  })

  // The regression this guards: an environment whose server is down when the
  // desktop launches. Resolving its route and credential used to happen in
  // the caller, so the failure produced no connection at all -- and with no
  // connection, nothing retried it. The server coming back changed nothing
  // until the operator clicked Reconnect.
  it('retries an attempt that cannot even be opened, and connects once it can', async () => {
    vi.useFakeTimers()
    try {
      FakeWebSocket.instances.length = 0
      let serverUp = false
      const broker = new Broker()
      const phases: string[] = []
      broker.onPhase((_envId, phase) => phases.push(phase.phase))
      broker.connect({
        environmentId: 'env-late',
        label: 'Server that starts later',
        transport: 'tcp',
        clientId: 'desktop-env-late',
        open: () => serverUp
          ? Promise.resolve({
            transport: 'tcp' as const,
            credential: { kind: 'local' as const },
            socket: new FakeWebSocket() as unknown as Awaited<ReturnType<ConnectionTarget['open']>>['socket'],
          })
          : Promise.reject(new Error('GET /auth/config failed: ECONNREFUSED')),
      })

      // Past the ladder and into the slow cadence: still nothing opened.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(FakeWebSocket.instances).toHaveLength(0)
      expect(broker.phaseOf('env-late')?.phase).toBe('offline')

      serverUp = true
      await vi.advanceTimersByTimeAsync(31_000)
      expect(FakeWebSocket.instances).toHaveLength(1)

      FakeWebSocket.instances[0].simulateOpen()
      FakeWebSocket.instances[0].simulateMessage(welcomeFrame())
      expect(broker.phaseOf('env-late')?.phase).toBe('connected')
      broker.disconnect('env-late')
    } finally {
      vi.useRealTimers()
    }
  })
})
