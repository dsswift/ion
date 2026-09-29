import { afterEach, describe, expect, it, vi } from 'vitest'

const fakeClients: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []

vi.mock('../../remote/relay-client', async () => {
  const { EventEmitter } = await import('events')
  // The channel subscribes to the client's 'message' events to run the
  // pair_request exchange, so the fake is an emitter like the real client.
  class FakeRelayClient extends EventEmitter {
    connect = vi.fn()
    disconnect = vi.fn()
    send = vi.fn()
    constructor() {
      super()
      fakeClients.push(this)
    }
  }
  return { RelayClient: FakeRelayClient }
})

import { createPairingChannel, cancelPairingChannel, isPairingChannelActive, _resetPairingChannelsForTest } from '../pairing-channels'

afterEach(() => {
  _resetPairingChannelsForTest()
  fakeClients.length = 0
})

describe('createPairingChannel', () => {
  it('mints a pairing:-prefixed channel id and connects a relay client', () => {
    const result = createPairingChannel('wss://relay.example.org', 'psk-value')
    expect(result.channelId).toMatch(/^pairing:[0-9a-f]{32}$/)
    expect(result.expiresAt).toBeGreaterThan(Date.now())
    expect(isPairingChannelActive(result.channelId)).toBe(true)
    expect(fakeClients).toHaveLength(1)
    expect(fakeClients[0].connect).toHaveBeenCalledOnce()
  })

  it('expires after its TTL, disconnecting the relay client', async () => {
    const result = createPairingChannel('wss://relay.example.org', 'psk-value', { ttlMs: 20 })
    expect(isPairingChannelActive(result.channelId)).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(isPairingChannelActive(result.channelId)).toBe(false)
    expect(fakeClients[0].disconnect).toHaveBeenCalledOnce()
  })
})

describe('cancelPairingChannel', () => {
  it('revokes an active channel and disconnects its relay client', () => {
    const result = createPairingChannel('wss://relay.example.org', 'psk-value')
    expect(cancelPairingChannel(result.channelId)).toBe(true)
    expect(isPairingChannelActive(result.channelId)).toBe(false)
    expect(fakeClients[0].disconnect).toHaveBeenCalledOnce()
  })

  it('returns false for an unknown channel id', () => {
    expect(cancelPairingChannel('pairing:does-not-exist')).toBe(false)
  })

  it('is idempotent-safe: cancelling twice does not throw and the second call returns false', () => {
    const result = createPairingChannel('wss://relay.example.org', 'psk-value')
    expect(cancelPairingChannel(result.channelId)).toBe(true)
    expect(cancelPairingChannel(result.channelId)).toBe(false)
  })
})
