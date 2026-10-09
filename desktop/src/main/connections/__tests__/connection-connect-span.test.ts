/**
 * `connection.connect`: one span per attempt, from the attempt starting to
 * the welcome, with the transport the attempt resolved (an SSH forward is
 * `ssh`, never `tcp`) and its route; a failed attempt is the same span with
 * the failure as its error.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const logged = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('../../logger', () => ({ log: logged.log, warn: logged.warn, debug: logged.debug, error: vi.fn() }))

import { EnvironmentConnection, type ConnectionTarget } from '../environment-connection'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 0
  sent: string[] = []
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = 1; this.emit('open') }
  message(frame: unknown): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
}

type Fields = Record<string, unknown>
const spans = (fn: ReturnType<typeof vi.fn>): Fields[] => fn.mock.calls.filter((c) => c[0] === 'span' && c[1] === 'connection.connect').map((c) => c[2] as Fields)
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function target(open: () => Promise<{ transport: 'local' | 'tcp' | 'ssh' | 'relay'; socket: FakeSocket; route?: string }>): ConnectionTarget {
  return { environmentId: 'env-1', label: 'devbox', transport: 'tcp', clientId: 'c', open: () => open().then((o) => ({ ...o, credential: { kind: 'local' as const } })) }
}

beforeEach(() => vi.clearAllMocks())

describe('connection.connect span', () => {
  it('ends on the welcome with the ssh transport and the tcp route the attempt resolved', async () => {
    const socket = new FakeSocket()
    const conn = new EnvironmentConnection(target(async () => ({ transport: 'ssh', socket, route: 'tcp' })), () => {}, () => {}, () => {})
    conn.connect()
    await tick()
    socket.open()
    socket.message({
      type: 'studio_welcome', protocolVersion: 1, environmentId: 'env-1', label: 'devbox', platform: 'linux', serverVersion: '0', engineVersion: '0',
      capabilities: ['a', 'b'], principal: { subject: 'local:test' }, scopes: [], enterprisePolicy: null, settingsHiddenGroups: [], snapshot: {},
    })
    const [fields] = spans(logged.log)
    expect(fields).toMatchObject({ environment_id: 'env-1', transport: 'ssh', route: 'tcp', attempt: 1, span_kind: 'client', 'peer.service': 'ion-server', server_capabilities: 2 })
    expect(spans(logged.warn)).toHaveLength(0)
    conn.disconnect()
  })

  it('records an attempt that could not open as the span error', async () => {
    const conn = new EnvironmentConnection(target(async () => { throw new Error('ssh: connection refused') }), () => {}, () => {}, () => {})
    conn.connect()
    await tick()
    expect(spans(logged.warn)[0]).toMatchObject({ environment_id: 'env-1', transport: 'tcp', error: 'ssh: connection refused' })
    conn.disconnect()
  })
})
