/**
 * A window that attaches after a connection's welcome still gets it.
 *
 * Main connects the local Environment at boot, before any window exists. A
 * window asking to connect it again keeps that socket, so the welcome was
 * never delivered to the window: the Personal preferences it declares there
 * (every local conversation started in plan mode), its Account settings, its
 * presence identity and its policy all stayed empty. `replayWelcome` hands
 * the live welcome over again and asks for a fresh snapshot.
 */
import { describe, it, expect } from 'vitest'
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
    settingsHiddenGroups: [], developerSurfaces: { sourceControl: true, commitGraph: true, repositoryStatus: true, worktrees: true, profiling: true }, policyHash: 'sha256:test',
    snapshot: {},
  }
}

describe('Broker.replayWelcome', () => {
  it('re-delivers the live welcome and asks the server for a fresh snapshot', async () => {
    FakeWebSocket.instances.length = 0
    const broker = new Broker()
    broker.connect(targetSpawning())
    await flush()
    const socket = FakeWebSocket.instances[0]
    socket.simulateOpen()
    socket.simulateMessage(welcomeFrame())

    const delivered: Array<{ environmentId: string; type: string }> = []
    broker.on('frame', (environmentId: string, frame: { type: string }) => delivered.push({ environmentId, type: frame.type }))
    socket.sent.length = 0

    expect(broker.replayWelcome('env-local', 'test')).toBe(true)
    expect(delivered).toEqual([{ environmentId: 'env-local', type: 'studio_welcome' }])
    expect(socket.sent.map((s) => JSON.parse(s).type)).toContain('studio_snapshot_request')
  })

  it('replays nothing before the connection is welcomed, or for an unknown environment', async () => {
    FakeWebSocket.instances.length = 0
    const broker = new Broker()
    broker.connect(targetSpawning())
    await flush()
    FakeWebSocket.instances[0].simulateOpen()

    const delivered: string[] = []
    broker.on('frame', (_environmentId: string, frame: { type: string }) => delivered.push(frame.type))
    expect(broker.replayWelcome('env-local', 'test')).toBe(false)
    expect(broker.replayWelcome('env-missing', 'test')).toBe(false)
    expect(delivered).toEqual([])
  })
})

describe('Broker.serverCapabilities', () => {
  it('answers what the live welcome advertised, and null before there is one', async () => {
    FakeWebSocket.instances.length = 0
    const broker = new Broker()
    broker.connect(targetSpawning())
    await flush()
    const socket = FakeWebSocket.instances[0]
    socket.simulateOpen()
    expect(broker.serverCapabilities('env-local')).toBeNull()
    expect(broker.serverCapabilities('env-missing')).toBeNull()

    socket.simulateMessage({ ...welcomeFrame(), capabilities: ['terminal', 'port-forward'] })

    expect(broker.serverCapabilities('env-local')).toEqual(['terminal', 'port-forward'])
  })
})
