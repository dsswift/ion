/**
 * A relay socket does not survive the host sleeping, so `lifecycle.systemWake`
 * has to make every one of them redial. The `desktop_*` transport renewed its
 * own relays and the Studio relay clients had no such path; the registry on
 * `RelayClient` is what covers both the environment channel and the
 * per-pairing channels without either construction site opting in.
 */
import { describe, expect, it, vi } from 'vitest'
import { RelayClient, renewRelayClientsAfterWake, liveRelayClientCount } from '../relay-client'

/** A client that never dials: `connect` is stubbed before anything calls it. */
function silentClient(): { client: RelayClient; connect: ReturnType<typeof vi.fn> } {
  const client = new RelayClient({ relayUrl: 'wss://relay.invalid', apiKey: 'psk', channelId: 'chan' })
  const connect = vi.fn()
  vi.spyOn(client, 'connect').mockImplementation(connect)
  return { client, connect }
}

describe('relay client wake renewal', () => {
  it('redials every live client and reports how many', () => {
    const before = liveRelayClientCount()
    const a = silentClient()
    const b = silentClient()
    expect(liveRelayClientCount()).toBe(before + 2)

    const renewed = renewRelayClientsAfterWake()

    expect(a.connect).toHaveBeenCalledOnce()
    expect(b.connect).toHaveBeenCalledOnce()
    expect(renewed).toBe(before + 2)
    a.client.disconnect()
    b.client.disconnect()
    expect(liveRelayClientCount()).toBe(before)
  })

  it('stops renewing a client once it has disconnected', () => {
    const a = silentClient()
    a.client.disconnect()

    renewRelayClientsAfterWake()

    expect(a.connect).not.toHaveBeenCalled()
  })
})
