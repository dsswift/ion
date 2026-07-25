import { describe, it, expect, vi, beforeEach } from 'vitest'

// updateConfig credential hot-swap must CREATE relay connections for paired
// devices that have none — not only update existing ones. Regression test for
// the OIDC bootstrap hole: start() skips relay creation when it runs with no
// usable credential (empty relayApiKey, getCredential not yet set because the
// relay auth-config probe is async). The probe then calls updateConfig with
// the credential provider; before the fix, updateConfig only iterated
// this.relays (empty), so ZERO relay connections were ever created and the
// desktop stayed LAN-only until a full restart. Mobile clients authenticated
// to the relay channel and found no desktop peer.

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Track RelayClient instantiations (one per device relay connection).
const relayInstances: { options: Record<string, unknown> }[] = []
vi.mock('../relay-client', () => ({
  RelayClient: class {
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
      relayInstances.push(this)
    }
    connect = vi.fn()
    disconnect = vi.fn()
    updateOptions = vi.fn()
    on = vi.fn()
    get isConnected() { return false }
  },
}))

vi.mock('../lan-server', () => ({
  LANServer: class {
    on = vi.fn()
    start = vi.fn(async () => {})
    stop = vi.fn(async () => {})
    hasClient = vi.fn(() => false)
  },
}))

vi.mock('../transport-send-worker-host', () => ({
  TransportCryptoHost: class {
    start = vi.fn()
    stop = vi.fn(async () => {})
    setSecrets = vi.fn()
  },
}))

import { RemoteTransport } from '../transport'

const DEVICE = {
  id: 'dev-1',
  name: 'iPhone',
  pairedAt: new Date().toISOString(),
  lastSeen: null,
  channelId: 'channel-1',
  sharedSecret: Buffer.alloc(32, 0x42).toString('base64'),
}

describe('updateConfig relay bootstrap (OIDC async probe)', () => {
  beforeEach(() => {
    relayInstances.length = 0
  })

  it('creates missing relay connections when a credential provider arrives after start()', async () => {
    // start() with NO usable relay credential: relayApiKey empty, no
    // getCredential — the exact state during the async OIDC probe window.
    const transport = new RemoteTransport({
      relayUrl: 'wss://relay.example.com',
      relayApiKey: '',
      lanPort: 0,
      getPairedDevice: (id: string) => (id === DEVICE.id ? (DEVICE as never) : null),
      getAllPairedDevices: () => [DEVICE as never],
    } as never)

    await transport.start()
    expect(relayInstances).toHaveLength(0) // no credential -> no relay connections

    // The probe detected OIDC and hot-swaps the credential provider.
    transport.updateConfig({
      relayApiKey: '',
      getCredential: async () => 'fresh-token',
    })

    // The fix: a relay connection is created for the paired device.
    expect(relayInstances).toHaveLength(1)
    expect(relayInstances[0].options.channelId).toBe(DEVICE.channelId)

    await transport.stop()
  })

  it('does not duplicate relay connections for devices that already have one', async () => {
    const transport = new RemoteTransport({
      relayUrl: 'wss://relay.example.com',
      relayApiKey: 'psk-key', // usable credential -> start() creates the relay
      lanPort: 0,
      getPairedDevice: (id: string) => (id === DEVICE.id ? (DEVICE as never) : null),
      getAllPairedDevices: () => [DEVICE as never],
    } as never)

    await transport.start()
    expect(relayInstances).toHaveLength(1)

    transport.updateConfig({
      relayApiKey: '',
      getCredential: async () => 'fresh-token',
    })

    // Existing connection updated in place, no second instance.
    expect(relayInstances).toHaveLength(1)

    await transport.stop()
  })
})
