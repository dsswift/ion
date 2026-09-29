/**
 * Unit-level (mocked `ws`) coverage of `RelayClient`'s `relay_announce`
 * sending (manifest C7): sent as the first frame after `open`, before the
 * `'connected'` event fires, and omitted entirely when no `announceTrust` is
 * configured. `relay-roundtrip.test.ts` covers the same behavior end-to-end
 * against a real relay binary; this file exercises it without requiring
 * `ION_RELAY_BIN`, so it always runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1
  readyState = MockWebSocket.OPEN
  sent: string[] = []

  constructor(_url: string, _opts?: { headers?: Record<string, string> }) {
    super()
  }

  close(): void {
    this.readyState = 3
  }

  send(data: string): void {
    this.sent.push(data)
  }

  fireOpen(): void {
    this.emit('open')
  }
}

let mockInstances: MockWebSocket[] = []

vi.mock('ws', () => {
  return {
    default: class extends MockWebSocket {
      constructor(url: string, opts?: { headers?: Record<string, string> }) {
        super(url, opts)
        mockInstances.push(this)
      }
    },
  }
})

let RelayClient: typeof import('../relay-client').RelayClient

beforeEach(async () => {
  mockInstances = []
  const mod = await import('../relay-client')
  RelayClient = mod.RelayClient
})

describe('RelayClient: relay_announce', () => {
  it('sends relay_announce as the first frame, before the connected event, when announceTrust is set', () => {
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.org',
      apiKey: 'psk',
      channelId: 'chan-1',
      announceTrust: { issuer: 'https://issuer.example.com', audience: 'api://server', scope: 'Studio.Access' },
    })

    let connectedFiredBeforeAnnounceCheck = false
    client.on('connected', () => {
      connectedFiredBeforeAnnounceCheck = true
    })

    client.connect()
    const ws = mockInstances[0]
    ws.fireOpen()

    expect(ws.sent).toHaveLength(1)
    const frame = JSON.parse(ws.sent[0])
    expect(frame).toEqual({
      type: 'relay_announce',
      trust: { issuer: 'https://issuer.example.com', audience: 'api://server', scope: 'Studio.Access' },
    })
    expect(connectedFiredBeforeAnnounceCheck).toBe(true)
  })

  it('sends a pairing announce frame when announceTrust is {pairing:true, expiresAt}', () => {
    const expiresAt = Date.now() + 60000
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.org',
      apiKey: 'psk',
      channelId: 'pairing:abc123',
      announceTrust: { pairing: true, expiresAt },
    })
    client.connect()
    const ws = mockInstances[0]
    ws.fireOpen()

    const frame = JSON.parse(ws.sent[0])
    expect(frame).toEqual({ type: 'relay_announce', trust: { pairing: true, expiresAt } })
  })

  it('sends no frame at all when announceTrust is omitted', () => {
    const client = new RelayClient({ relayUrl: 'wss://relay.example.org', apiKey: 'psk', channelId: 'chan-1' })
    client.connect()
    const ws = mockInstances[0]
    ws.fireOpen()

    expect(ws.sent).toEqual([])
  })
})
