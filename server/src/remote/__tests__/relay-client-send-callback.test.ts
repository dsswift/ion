/**
 * `RelayClient.send`'s callback reports when the message actually left the
 * relay socket. The relay carrier used to report every send as done the
 * moment it was queued, so a Connection pacing its answers on delivery
 * (`Connection.answerInTurn`) paced nothing over a relay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1
  readyState = MockWebSocket.OPEN
  held: Array<(err?: Error) => void> = []
  constructor(_url: string, _opts?: unknown) { super() }
  close(): void { this.readyState = 3 }
  send(_data: string, cb?: (err?: Error) => void): void { if (cb) this.held.push(cb) }
}

let mockInstances: MockWebSocket[] = []
vi.mock('ws', () => ({
  default: class extends MockWebSocket {
    constructor(url: string, opts?: unknown) { super(url, opts); mockInstances.push(this) }
  },
}))

let RelayClient: typeof import('../relay-client').RelayClient
let relayCarrier: typeof import('../../protocol/sealed-socket').relayCarrier

beforeEach(async () => {
  mockInstances = []
  RelayClient = (await import('../relay-client')).RelayClient
  relayCarrier = (await import('../../protocol/sealed-socket')).relayCarrier
})

function connectedClient(): { client: InstanceType<typeof RelayClient>; ws: MockWebSocket } {
  const client = new RelayClient({ relayUrl: 'wss://relay.example.org', apiKey: 'psk', channelId: 'chan-1' })
  client.connect()
  const ws = mockInstances[0]
  ws.emit('open')
  return { client, ws }
}

describe('RelayClient.send callback', () => {
  it('fires only once the socket reports the message written', () => {
    const { client, ws } = connectedClient()
    const done = vi.fn()
    client.send({ type: 'x' } as never, done)
    expect(done).not.toHaveBeenCalled()
    ws.held.shift()?.()
    expect(done).toHaveBeenCalledWith(undefined)
  })

  it('reports an error when the relay is not connected', () => {
    const { client, ws } = connectedClient()
    ws.readyState = 3
    const done = vi.fn()
    client.send({ type: 'x' } as never, done)
    expect(done.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('the relay carrier passes the real delivery moment through', () => {
    const { client, ws } = connectedClient()
    const done = vi.fn()
    relayCarrier(client).sendEnvelope(JSON.stringify({ type: 'x' }), done)
    expect(done).not.toHaveBeenCalled()
    ws.held.shift()?.()
    expect(done).toHaveBeenCalledTimes(1)
  })
})
